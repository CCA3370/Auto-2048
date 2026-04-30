use super::{
    default_evaluated_moves, normalize_thinking_strength, now_ms, order_moves,
    resolve_search_config, Board, DecisionConfig, EvaluatedMove, FindBestMoveOptions,
    SearchDecision, SearchMetrics, DEFAULT_THINKING_STRENGTH,
};
use std::os::raw::{c_char, c_int};

const CUDA_ERROR_BUFFER_LEN: usize = 1024;

#[repr(C)]
#[derive(Clone, Copy)]
struct CudaRootMoveInput {
    board: u64,
    direction: u32,
    immediate_score: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CudaRootMoveOutput {
    score_sum: f64,
    max_tile_sum: u64,
    deaths: u32,
    completed: u32,
}

extern "C" {
    fn cuda_rollout_device_count(count: *mut c_int, error: *mut c_char, error_len: usize) -> c_int;
    fn cuda_rollout_device_name(
        device_index: c_int,
        name: *mut c_char,
        name_len: usize,
        error: *mut c_char,
        error_len: usize,
    ) -> c_int;
    fn cuda_rollout_evaluate(
        device_index: c_int,
        inputs: *const CudaRootMoveInput,
        move_count: usize,
        rollouts_per_move: u32,
        step_limit: u32,
        seed: u64,
        outputs: *mut CudaRootMoveOutput,
        error: *mut c_char,
        error_len: usize,
    ) -> c_int;
}

pub(crate) fn device_count() -> Result<i32, String> {
    let mut count: c_int = 0;
    let mut error = error_buffer();
    let code = unsafe { cuda_rollout_device_count(&mut count, error.as_mut_ptr(), error.len()) };
    if code == 0 {
        Ok(count)
    } else {
        Err(format_cuda_error(&error))
    }
}

pub(crate) fn device_name(gpu_index: u32) -> Result<String, String> {
    let mut name = vec![0 as c_char; 256];
    let mut error = error_buffer();
    let code = unsafe {
        cuda_rollout_device_name(
            gpu_index as c_int,
            name.as_mut_ptr(),
            name.len(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if code == 0 {
        Ok(buffer_to_string(&name))
    } else {
        Err(format_cuda_error(&error))
    }
}

pub(crate) fn find_best_move_cuda_rollout(
    board: Board,
    options: &FindBestMoveOptions,
    decision_config: &DecisionConfig,
) -> Result<Option<SearchDecision>, String> {
    let start_time = now_ms();
    let search_config = resolve_search_config(&board, options);
    let preferred_corner = super::choose_preferred_corner(&board);
    let ordered_moves = order_moves(&board, &search_config, preferred_corner);
    if ordered_moves.is_empty() {
        return Ok(None);
    }

    let inputs: Vec<CudaRootMoveInput> = ordered_moves
        .iter()
        .map(|ordered_move| CudaRootMoveInput {
            board: ordered_move.board.0,
            direction: ordered_move.direction.index() as u32,
            immediate_score: ordered_move.score,
        })
        .collect();
    let rollouts = decision_config.resolved_rollouts(options).max(1);
    let rollout_steps = decision_config.rollout_steps.max(1);
    let mut outputs = vec![CudaRootMoveOutput::default(); inputs.len()];
    let mut error = error_buffer();
    let seed = rollout_seed(board, options, decision_config);

    let code = unsafe {
        cuda_rollout_evaluate(
            decision_config.gpu_index as c_int,
            inputs.as_ptr(),
            inputs.len(),
            rollouts,
            rollout_steps,
            seed,
            outputs.as_mut_ptr(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if code != 0 {
        return Err(format!(
            "CUDA rollout backend failed on gpu {}: {}. Re-run with --backend cpu or rebuild without requesting CUDA.",
            decision_config.gpu_index,
            format_cuda_error(&error)
        ));
    }

    let mut evaluated = default_evaluated_moves();
    let mut best_direction = None;
    let mut best_score = f64::NEG_INFINITY;

    for (ordered_move, output) in ordered_moves.iter().zip(outputs.iter()) {
        if output.completed == 0 {
            continue;
        }

        let completed = output.completed as f64;
        let average_score = output.score_sum / completed;
        let average_max_tile = output.max_tile_sum as f64 / completed;
        let death_rate = output.deaths as f64 / completed;
        let score = average_score + average_max_tile * 6.0 - death_rate * 6500.0;
        let direction_name = ordered_move.direction.as_str().to_string();

        evaluated[ordered_move.direction.index() as usize] = EvaluatedMove {
            direction: direction_name.clone(),
            score,
            valid: true,
        };

        if score > best_score {
            best_score = score;
            best_direction = Some(direction_name);
        }
    }

    Ok(Some(SearchDecision {
        best_direction,
        best_score,
        depth: 0,
        evaluated_moves: evaluated,
        metrics: SearchMetrics {
            nodes: rollouts.saturating_mul(inputs.len() as u32),
            cache_hits: 0,
            cache_misses: 0,
            chance_nodes: inputs.len() as u32,
            duration_ms: now_ms() - start_time,
            timed_out: false,
        },
    }))
}

fn rollout_seed(
    board: Board,
    options: &FindBestMoveOptions,
    decision_config: &DecisionConfig,
) -> u64 {
    let strength = normalize_thinking_strength(
        options
            .thinking_strength
            .unwrap_or(DEFAULT_THINKING_STRENGTH as f64),
    );
    board.0
        ^ ((decision_config.gpu_index as u64) << 48)
        ^ ((decision_config.resolved_rollouts(options) as u64) << 16)
        ^ decision_config.rollout_steps as u64
        ^ ((strength as u64) << 56)
}

fn error_buffer() -> Vec<c_char> {
    vec![0 as c_char; CUDA_ERROR_BUFFER_LEN]
}

fn format_cuda_error(buffer: &[c_char]) -> String {
    let message = buffer_to_string(buffer);
    if message.trim().is_empty() {
        "unknown CUDA error".to_string()
    } else {
        message
    }
}

fn buffer_to_string(buffer: &[c_char]) -> String {
    let bytes: Vec<u8> = buffer
        .iter()
        .copied()
        .take_while(|value| *value != 0)
        .map(|value| value as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}
