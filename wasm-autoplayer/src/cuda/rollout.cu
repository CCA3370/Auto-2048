#include <cuda_runtime.h>

#include <stdint.h>
#include <stdio.h>
#include <string.h>

struct CudaRootMoveInput {
  uint64_t board;
  uint32_t direction;
  uint32_t immediate_score;
};

struct CudaRootMoveOutput {
  double score_sum;
  uint64_t max_tile_sum;
  uint32_t deaths;
  uint32_t completed;
};

static void set_error(char *error, size_t error_len, const char *message) {
  if (error != nullptr && error_len > 0) {
    snprintf(error, error_len, "%s", message);
  }
}

static int set_cuda_error(char *error, size_t error_len, const char *action,
                          cudaError_t status) {
  if (error != nullptr && error_len > 0) {
    snprintf(error, error_len, "%s: %s", action, cudaGetErrorString(status));
  }
  return 1;
}

__device__ __forceinline__ uint8_t rank_at(uint64_t board, int index) {
  return static_cast<uint8_t>((board >> (index * 4)) & 0xFULL);
}

__device__ __forceinline__ uint64_t set_rank_at(uint64_t board, int index,
                                                 uint8_t rank) {
  const uint64_t mask = 0xFULL << (index * 4);
  board &= ~mask;
  board |= (static_cast<uint64_t>(rank > 15 ? 15 : rank) << (index * 4));
  return board;
}

__device__ __forceinline__ uint16_t row_key(uint64_t board, int row) {
  return static_cast<uint16_t>((board >> (row * 16)) & 0xFFFFULL);
}

__device__ __forceinline__ uint64_t set_row_key(uint64_t board, int row,
                                                 uint16_t key) {
  const int shift = row * 16;
  board &= ~(0xFFFFULL << shift);
  board |= static_cast<uint64_t>(key) << shift;
  return board;
}

__device__ uint16_t column_key(uint64_t board, int col) {
  uint16_t key = 0;
  for (int row = 0; row < 4; ++row) {
    key |= static_cast<uint16_t>(rank_at(board, row * 4 + col)) << (row * 4);
  }
  return key;
}

__device__ uint64_t set_column_key(uint64_t board, int col, uint16_t key) {
  for (int row = 0; row < 4; ++row) {
    board = set_rank_at(board, row * 4 + col,
                        static_cast<uint8_t>((key >> (row * 4)) & 0xF));
  }
  return board;
}

__device__ __forceinline__ uint8_t row_rank(uint16_t row, int index) {
  return static_cast<uint8_t>((row >> (index * 4)) & 0xF);
}

__device__ uint16_t pack_row(const uint8_t ranks[4]) {
  uint16_t row = 0;
  for (int index = 0; index < 4; ++index) {
    row |= static_cast<uint16_t>(ranks[index]) << (index * 4);
  }
  return row;
}

__device__ uint16_t reverse_row(uint16_t row) {
  uint8_t ranks[4] = {row_rank(row, 3), row_rank(row, 2), row_rank(row, 1),
                      row_rank(row, 0)};
  return pack_row(ranks);
}

__device__ uint16_t move_row_left(uint16_t row, uint32_t *score) {
  uint8_t tiles[4] = {0, 0, 0, 0};
  int tile_count = 0;
  for (int index = 0; index < 4; ++index) {
    const uint8_t rank = row_rank(row, index);
    if (rank != 0) {
      tiles[tile_count++] = rank;
    }
  }

  uint8_t output[4] = {0, 0, 0, 0};
  int read = 0;
  int write = 0;
  *score = 0;
  while (read < tile_count) {
    if (read + 1 < tile_count && tiles[read] == tiles[read + 1]) {
      const uint8_t merged = tiles[read] == 15 ? 15 : tiles[read] + 1;
      output[write++] = merged;
      *score += 1U << merged;
      read += 2;
    } else {
      output[write++] = tiles[read++];
    }
  }

  return pack_row(output);
}

__device__ uint16_t move_row_right(uint16_t row, uint32_t *score) {
  const uint16_t reversed = reverse_row(row);
  const uint16_t moved = move_row_left(reversed, score);
  return reverse_row(moved);
}

__device__ bool simulate_move(uint64_t board, int direction, uint64_t *next,
                              uint32_t *score) {
  uint64_t result = board;
  uint32_t total_score = 0;
  bool moved = false;

  if (direction == 2) {
    for (int row = 0; row < 4; ++row) {
      const uint16_t old_key = row_key(result, row);
      uint32_t row_score = 0;
      const uint16_t new_key = move_row_left(old_key, &row_score);
      moved = moved || new_key != old_key;
      result = set_row_key(result, row, new_key);
      total_score += row_score;
    }
  } else if (direction == 3) {
    for (int row = 0; row < 4; ++row) {
      const uint16_t old_key = row_key(result, row);
      uint32_t row_score = 0;
      const uint16_t new_key = move_row_right(old_key, &row_score);
      moved = moved || new_key != old_key;
      result = set_row_key(result, row, new_key);
      total_score += row_score;
    }
  } else if (direction == 0) {
    for (int col = 0; col < 4; ++col) {
      const uint16_t old_key = column_key(result, col);
      uint32_t col_score = 0;
      const uint16_t new_key = move_row_left(old_key, &col_score);
      moved = moved || new_key != old_key;
      result = set_column_key(result, col, new_key);
      total_score += col_score;
    }
  } else {
    for (int col = 0; col < 4; ++col) {
      const uint16_t old_key = column_key(result, col);
      uint32_t col_score = 0;
      const uint16_t new_key = move_row_right(old_key, &col_score);
      moved = moved || new_key != old_key;
      result = set_column_key(result, col, new_key);
      total_score += col_score;
    }
  }

  *next = result;
  *score = total_score;
  return moved;
}

__device__ bool can_move(uint64_t board) {
  for (int direction = 0; direction < 4; ++direction) {
    uint64_t next = 0;
    uint32_t score = 0;
    if (simulate_move(board, direction, &next, &score)) {
      return true;
    }
  }
  return false;
}

__device__ int empty_count(uint64_t board) {
  int count = 0;
  for (int index = 0; index < 16; ++index) {
    count += rank_at(board, index) == 0 ? 1 : 0;
  }
  return count;
}

__device__ uint8_t max_rank(uint64_t board) {
  uint8_t max_seen = 0;
  for (int index = 0; index < 16; ++index) {
    const uint8_t rank = rank_at(board, index);
    max_seen = rank > max_seen ? rank : max_seen;
  }
  return max_seen;
}

__device__ uint32_t max_tile(uint64_t board) {
  const uint8_t rank = max_rank(board);
  return rank == 0 ? 0U : 1U << rank;
}

__device__ int merge_count(uint64_t board) {
  int count = 0;
  for (int row = 0; row < 4; ++row) {
    for (int col = 0; col < 4; ++col) {
      const int index = row * 4 + col;
      const uint8_t rank = rank_at(board, index);
      if (rank == 0) {
        continue;
      }
      if (col + 1 < 4 && rank == rank_at(board, index + 1)) {
        ++count;
      }
      if (row + 1 < 4 && rank == rank_at(board, index + 4)) {
        ++count;
      }
    }
  }
  return count;
}

__device__ int edge_rank_sum(uint64_t board) {
  int sum = 0;
  for (int row = 0; row < 4; ++row) {
    for (int col = 0; col < 4; ++col) {
      if (row == 0 || row == 3 || col == 0 || col == 3) {
        sum += rank_at(board, row * 4 + col);
      }
    }
  }
  return sum;
}

__device__ int smoothness_penalty(uint64_t board) {
  int penalty = 0;
  for (int row = 0; row < 4; ++row) {
    for (int col = 0; col < 4; ++col) {
      const int index = row * 4 + col;
      const int current = rank_at(board, index);
      if (current == 0) {
        continue;
      }
      if (col + 1 < 4) {
        const int right = rank_at(board, index + 1);
        if (right != 0) {
          penalty += current > right ? current - right : right - current;
        }
      }
      if (row + 1 < 4) {
        const int down = rank_at(board, index + 4);
        if (down != 0) {
          penalty += current > down ? current - down : down - current;
        }
      }
    }
  }
  return penalty;
}

__device__ int snake_score(uint64_t board) {
  const int weights[16] = {15, 14, 13, 12, 8, 9, 10, 11,
                           7,  6,  5,  4,  0, 1, 2,  3};
  int score = 0;
  for (int index = 0; index < 16; ++index) {
    score += static_cast<int>(rank_at(board, index)) * weights[index];
  }
  return score;
}

__device__ uint32_t rng_u32(uint64_t *state) {
  uint64_t z = (*state += 0x9E3779B97F4A7C15ULL);
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
  return static_cast<uint32_t>((z ^ (z >> 31)) >> 32);
}

__device__ uint64_t spawn_random_tile(uint64_t board, uint64_t *rng) {
  const int empty = empty_count(board);
  if (empty == 0) {
    return board;
  }

  const int target = static_cast<int>(rng_u32(rng) % static_cast<uint32_t>(empty));
  const uint8_t rank = rng_u32(rng) < 3865470566U ? 1 : 2;
  int seen = 0;
  for (int index = 0; index < 16; ++index) {
    if (rank_at(board, index) != 0) {
      continue;
    }
    if (seen == target) {
      return set_rank_at(board, index, rank);
    }
    ++seen;
  }
  return board;
}

__device__ double rollout_move_score(uint64_t next, uint32_t move_score) {
  const int empty = empty_count(next);
  const int max_seen = max_rank(next);
  return static_cast<double>(move_score) * 4.0 +
         static_cast<double>(empty) * 230.0 +
         static_cast<double>(empty * empty) * 85.0 +
         static_cast<double>(max_seen * max_seen) * 42.0 +
         static_cast<double>(merge_count(next)) * 115.0 +
         static_cast<double>(edge_rank_sum(next)) * 18.0 +
         static_cast<double>(snake_score(next)) * 4.5 -
         static_cast<double>(smoothness_penalty(next)) * 38.0;
}

__device__ bool choose_rollout_move(uint64_t board, uint64_t *rng,
                                    int *selected_direction) {
  int valid_directions[4] = {0, 0, 0, 0};
  int valid_count = 0;
  int best_direction = 0;
  double best_score = -1.0e100;

  for (int direction = 0; direction < 4; ++direction) {
    uint64_t next = 0;
    uint32_t score = 0;
    if (!simulate_move(board, direction, &next, &score)) {
      continue;
    }

    valid_directions[valid_count++] = direction;
    const double candidate = rollout_move_score(next, score);
    if (candidate > best_score) {
      best_score = candidate;
      best_direction = direction;
    }
  }

  if (valid_count == 0) {
    return false;
  }

  if (valid_count > 1 && (rng_u32(rng) % 100U) < 15U) {
    *selected_direction =
        valid_directions[rng_u32(rng) % static_cast<uint32_t>(valid_count)];
  } else {
    *selected_direction = best_direction;
  }
  return true;
}

__global__ void rollout_kernel(const CudaRootMoveInput *inputs, size_t move_count,
                               uint32_t rollouts_per_move,
                               uint32_t step_limit, uint64_t seed,
                               CudaRootMoveOutput *outputs) {
  const uint64_t thread_index =
      static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  const uint64_t total_rollouts =
      static_cast<uint64_t>(move_count) * rollouts_per_move;
  if (thread_index >= total_rollouts) {
    return;
  }

  const size_t move_index = static_cast<size_t>(thread_index / rollouts_per_move);
  const CudaRootMoveInput input = inputs[move_index];
  uint64_t rng = seed ^ input.board ^
                 (thread_index + 1ULL) * 0xD1B54A32D192ED03ULL ^
                 static_cast<uint64_t>(input.direction) * 0x94D049BB133111EBULL;
  uint64_t board = input.board;
  uint32_t total_score = input.immediate_score;
  uint32_t died = 0;

  if (empty_count(board) > 0) {
    board = spawn_random_tile(board, &rng);
  }

  for (uint32_t step = 0; step < step_limit; ++step) {
    int direction = 0;
    if (!choose_rollout_move(board, &rng, &direction)) {
      died = 1;
      break;
    }

    uint64_t next = 0;
    uint32_t move_score = 0;
    if (!simulate_move(board, direction, &next, &move_score)) {
      died = can_move(board) ? 0 : 1;
      break;
    }

    board = next;
    total_score += move_score;
    if (empty_count(board) > 0) {
      board = spawn_random_tile(board, &rng);
    }
  }

  atomicAdd(&outputs[move_index].score_sum, static_cast<double>(total_score));
  atomicAdd(reinterpret_cast<unsigned long long *>(
                &outputs[move_index].max_tile_sum),
            static_cast<unsigned long long>(max_tile(board)));
  atomicAdd(&outputs[move_index].deaths, died);
  atomicAdd(&outputs[move_index].completed, 1U);
}

extern "C" int cuda_rollout_device_count(int *count, char *error,
                                          size_t error_len) {
  if (count == nullptr) {
    set_error(error, error_len, "device count output pointer is null");
    return 1;
  }

  int local_count = 0;
  const cudaError_t status = cudaGetDeviceCount(&local_count);
  if (status != cudaSuccess) {
    return set_cuda_error(error, error_len, "cudaGetDeviceCount failed", status);
  }

  *count = local_count;
  set_error(error, error_len, "");
  return 0;
}

extern "C" int cuda_rollout_device_name(int device_index, char *name,
                                         size_t name_len, char *error,
                                         size_t error_len) {
  cudaDeviceProp props;
  const cudaError_t status = cudaGetDeviceProperties(&props, device_index);
  if (status != cudaSuccess) {
    return set_cuda_error(error, error_len, "cudaGetDeviceProperties failed",
                          status);
  }

  if (name != nullptr && name_len > 0) {
    snprintf(name, name_len, "%s", props.name);
  }
  set_error(error, error_len, "");
  return 0;
}

extern "C" int cuda_rollout_evaluate(
    int device_index, const CudaRootMoveInput *inputs, size_t move_count,
    uint32_t rollouts_per_move, uint32_t step_limit, uint64_t seed,
    CudaRootMoveOutput *outputs, char *error, size_t error_len) {
  if (inputs == nullptr || outputs == nullptr) {
    set_error(error, error_len, "input or output pointer is null");
    return 1;
  }
  if (move_count == 0 || rollouts_per_move == 0 || step_limit == 0) {
    set_error(error, error_len, "move count, rollouts, and step limit must be positive");
    return 1;
  }

  cudaError_t status = cudaSetDevice(device_index);
  if (status != cudaSuccess) {
    return set_cuda_error(error, error_len, "cudaSetDevice failed", status);
  }

  CudaRootMoveInput *device_inputs = nullptr;
  CudaRootMoveOutput *device_outputs = nullptr;
  const size_t input_bytes = sizeof(CudaRootMoveInput) * move_count;
  const size_t output_bytes = sizeof(CudaRootMoveOutput) * move_count;

  status = cudaMalloc(reinterpret_cast<void **>(&device_inputs), input_bytes);
  if (status != cudaSuccess) {
    return set_cuda_error(error, error_len, "cudaMalloc inputs failed", status);
  }

  status = cudaMalloc(reinterpret_cast<void **>(&device_outputs), output_bytes);
  if (status != cudaSuccess) {
    cudaFree(device_inputs);
    return set_cuda_error(error, error_len, "cudaMalloc outputs failed", status);
  }

  status = cudaMemcpy(device_inputs, inputs, input_bytes, cudaMemcpyHostToDevice);
  if (status != cudaSuccess) {
    cudaFree(device_outputs);
    cudaFree(device_inputs);
    return set_cuda_error(error, error_len, "cudaMemcpy inputs failed", status);
  }

  status = cudaMemset(device_outputs, 0, output_bytes);
  if (status != cudaSuccess) {
    cudaFree(device_outputs);
    cudaFree(device_inputs);
    return set_cuda_error(error, error_len, "cudaMemset outputs failed", status);
  }

  const uint64_t total_rollouts =
      static_cast<uint64_t>(move_count) * rollouts_per_move;
  const int threads_per_block = 256;
  const int blocks = static_cast<int>((total_rollouts + threads_per_block - 1) /
                                      threads_per_block);
  rollout_kernel<<<blocks, threads_per_block>>>(
      device_inputs, move_count, rollouts_per_move, step_limit, seed,
      device_outputs);

  status = cudaGetLastError();
  if (status != cudaSuccess) {
    cudaFree(device_outputs);
    cudaFree(device_inputs);
    return set_cuda_error(error, error_len, "rollout kernel launch failed",
                          status);
  }

  status = cudaDeviceSynchronize();
  if (status != cudaSuccess) {
    cudaFree(device_outputs);
    cudaFree(device_inputs);
    return set_cuda_error(error, error_len, "rollout kernel failed", status);
  }

  status = cudaMemcpy(outputs, device_outputs, output_bytes, cudaMemcpyDeviceToHost);
  cudaFree(device_outputs);
  cudaFree(device_inputs);
  if (status != cudaSuccess) {
    return set_cuda_error(error, error_len, "cudaMemcpy outputs failed", status);
  }

  set_error(error, error_len, "");
  return 0;
}
