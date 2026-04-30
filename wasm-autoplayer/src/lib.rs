use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use wasm_bindgen::prelude::*;

#[cfg(all(feature = "cuda", not(target_arch = "wasm32")))]
mod cuda_rollout;

#[cfg(not(all(feature = "cuda", not(target_arch = "wasm32"))))]
mod cuda_rollout {
    use super::{Board, DecisionConfig, FindBestMoveOptions, SearchDecision};

    pub(crate) fn device_count() -> Result<i32, String> {
        Err(unavailable_message())
    }

    pub(crate) fn device_name(_gpu_index: u32) -> Result<String, String> {
        Err(unavailable_message())
    }

    pub(crate) fn find_best_move_cuda_rollout(
        _board: Board,
        _options: &FindBestMoveOptions,
        _decision_config: &DecisionConfig,
    ) -> Result<Option<SearchDecision>, String> {
        Err(unavailable_message())
    }

    fn unavailable_message() -> String {
        "CUDA rollout backend is not available in this build. Rebuild the native CLI with --features cuda and a CUDA Toolkit installation that provides nvcc.".to_string()
    }
}

const SIZE: usize = 4;
const CELLS: usize = SIZE * SIZE;
const ROW_TABLE_SIZE: usize = 1 << 16;
const CELL_MASK: u64 = 0xF;
const MAX_TILE_EXPONENT: u8 = 15;
const MAX_SEARCH_DEPTH: u32 = 10;
const DEFAULT_ROLLOUT_STEPS: u32 = 512;
const PROB_2: f64 = 0.9;
const PROB_4: f64 = 0.1;
const DEFAULT_THINKING_STRENGTH: u32 = 6;
const DEFAULT_PRESET: HeuristicPresetName = HeuristicPresetName::Balanced;

#[wasm_bindgen]
pub fn find_best_move(board: Vec<u32>, options: JsValue) -> Result<JsValue, JsValue> {
    let board = Board::from_values(&board).map_err(js_error)?;
    let options = parse_find_options(options)?;
    let decision = find_best_move_core(board, &options);
    serde_wasm_bindgen::to_value(&decision).map_err(|err| js_error(err.to_string()))
}

#[wasm_bindgen]
pub fn run_benchmark(
    seeds: JsValue,
    strategies: JsValue,
    max_moves: u32,
) -> Result<JsValue, JsValue> {
    let seeds: Vec<Seed> =
        serde_wasm_bindgen::from_value(seeds).map_err(|err| js_error(err.to_string()))?;
    let strategies: Vec<BenchmarkStrategyConfig> =
        serde_wasm_bindgen::from_value(strategies).map_err(|err| js_error(err.to_string()))?;
    let max_moves = if max_moves == 0 {
        None
    } else {
        Some(max_moves)
    };
    let summaries = run_benchmark_core(&seeds, &strategies, max_moves);
    serde_wasm_bindgen::to_value(&summaries).map_err(|err| js_error(err.to_string()))
}

#[wasm_bindgen]
pub fn simulate_move_for_board(board: Vec<u32>, direction: u8) -> Result<JsValue, JsValue> {
    let board = Board::from_values(&board).map_err(js_error)?;
    let direction =
        Direction::from_index(direction).ok_or_else(|| js_error("invalid direction"))?;
    let result = simulate_move(board, direction);
    serde_wasm_bindgen::to_value(&MoveSimulationResult::from(result))
        .map_err(|err| js_error(err.to_string()))
}

#[wasm_bindgen]
pub fn evaluate_board(board: Vec<u32>, options: JsValue) -> Result<f64, JsValue> {
    let board = Board::from_values(&board).map_err(js_error)?;
    let options = parse_evaluation_options(options)?;
    Ok(evaluate(&board, &options))
}

pub fn find_best_move_for_values(
    values: &[u32],
    options: FindBestMoveOptions,
) -> Result<Option<SearchDecision>, String> {
    find_best_move_for_values_with_decision_config(values, options, &DecisionConfig::default())
}

pub fn find_best_move_for_values_with_decision_config(
    values: &[u32],
    options: FindBestMoveOptions,
    decision_config: &DecisionConfig,
) -> Result<Option<SearchDecision>, String> {
    find_best_move_with_decision_config(Board::from_values(values)?, &options, decision_config)
}

pub fn simulate_move_for_values(
    values: &[u32],
    direction: &str,
) -> Result<MoveSimulationResult, String> {
    let board = Board::from_values(values)?;
    let direction =
        Direction::from_name(direction).ok_or_else(|| format!("invalid direction: {direction}"))?;
    Ok(MoveSimulationResult::from(simulate_move(board, direction)))
}

pub fn evaluate_board_values(values: &[u32], options: EvaluationOptions) -> Result<f64, String> {
    let board = Board::from_values(values)?;
    Ok(evaluate(&board, &options))
}

pub fn run_benchmark_for_configs(
    seeds: &[Seed],
    strategies: &[BenchmarkStrategyConfig],
    max_moves: Option<u32>,
) -> Vec<BenchmarkSummary> {
    run_benchmark_core(seeds, strategies, max_moves)
}

pub fn run_benchmark_for_configs_with_progress(
    seeds: &[Seed],
    strategies: &[BenchmarkStrategyConfig],
    max_moves: Option<u32>,
    mut on_progress: impl FnMut(&BenchmarkProgress),
) -> Vec<BenchmarkSummary> {
    run_benchmark_core_with_progress(seeds, strategies, max_moves, &mut on_progress)
}

pub fn run_benchmark_for_configs_with_decision_config(
    seeds: &[Seed],
    strategies: &[BenchmarkStrategyConfig],
    max_moves: Option<u32>,
    decision_config: &DecisionConfig,
) -> Result<Vec<BenchmarkSummary>, String> {
    let mut ignore_progress = ignore_benchmark_progress;
    run_benchmark_core_with_progress_and_decision_config(
        seeds,
        strategies,
        max_moves,
        decision_config,
        &mut ignore_progress,
    )
}

pub fn run_benchmark_for_configs_with_progress_and_decision_config(
    seeds: &[Seed],
    strategies: &[BenchmarkStrategyConfig],
    max_moves: Option<u32>,
    decision_config: &DecisionConfig,
    mut on_progress: impl FnMut(&BenchmarkProgress),
) -> Result<Vec<BenchmarkSummary>, String> {
    run_benchmark_core_with_progress_and_decision_config(
        seeds,
        strategies,
        max_moves,
        decision_config,
        &mut on_progress,
    )
}

pub fn play_game_for_config(
    seed: Seed,
    strategy: &BenchmarkStrategyConfig,
    max_moves: u32,
) -> BenchmarkGameResult {
    run_benchmark_game(seed, strategy, max_moves)
}

pub fn play_game_for_config_with_decision_config(
    seed: Seed,
    strategy: &BenchmarkStrategyConfig,
    max_moves: u32,
    decision_config: &DecisionConfig,
) -> Result<BenchmarkGameResult, String> {
    run_benchmark_game_with_decision_config(seed, strategy, max_moves, decision_config)
}

pub fn cuda_device_count() -> Result<i32, String> {
    cuda_rollout::device_count()
}

pub fn cuda_device_name(gpu_index: u32) -> Result<String, String> {
    cuda_rollout::device_name(gpu_index)
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Board(u64);

impl Board {
    fn from_values(values: &[u32]) -> Result<Self, String> {
        if values.len() != CELLS {
            return Err(format!(
                "expected {CELLS} board values, got {}",
                values.len()
            ));
        }

        let mut board = Self::empty();
        for (index, value) in values.iter().copied().enumerate() {
            board.set_rank_at_index(index, tile_value_to_rank(value)?);
        }
        Ok(board)
    }

    fn empty() -> Self {
        Self(0)
    }

    fn get(&self, row: usize, col: usize) -> u32 {
        rank_to_tile_value(self.rank(row, col))
    }

    fn set(&mut self, row: usize, col: usize, value: u32) {
        self.set_rank(
            row,
            col,
            tile_value_to_rank(value).expect("invalid tile value"),
        );
    }

    fn rank(&self, row: usize, col: usize) -> u8 {
        self.rank_at_index(row * SIZE + col)
    }

    fn rank_at_index(&self, index: usize) -> u8 {
        ((self.0 >> (index * 4)) & CELL_MASK) as u8
    }

    fn set_rank(&mut self, row: usize, col: usize, rank: u8) {
        self.set_rank_at_index(row * SIZE + col, rank);
    }

    fn set_rank_at_index(&mut self, index: usize, rank: u8) {
        let shift = index * 4;
        self.0 &= !(CELL_MASK << shift);
        self.0 |= (rank.min(MAX_TILE_EXPONENT) as u64) << shift;
    }

    fn row_key(&self, row: usize) -> u16 {
        ((self.0 >> (row * 16)) & 0xFFFF) as u16
    }

    fn set_row_key(&mut self, row: usize, key: u16) {
        let shift = row * 16;
        self.0 &= !(0xFFFF_u64 << shift);
        self.0 |= (key as u64) << shift;
    }

    fn column_key(&self, col: usize) -> u16 {
        let mut key = 0_u16;
        for row in 0..SIZE {
            key |= (self.rank(row, col) as u16) << (row * 4);
        }
        key
    }

    fn set_column_key(&mut self, col: usize, key: u16) {
        for row in 0..SIZE {
            self.set_rank(row, col, row_rank(key, row));
        }
    }

    fn rows(&self) -> [[u32; SIZE]; SIZE] {
        let mut rows = [[0; SIZE]; SIZE];
        for row in 0..SIZE {
            for col in 0..SIZE {
                rows[row][col] = self.get(row, col);
            }
        }
        rows
    }

    fn spawn(&self, row: usize, col: usize, value: u32) -> Self {
        let mut next = *self;
        next.set(row, col, value);
        next
    }

    fn empty_cells(&self) -> Vec<(usize, usize)> {
        let mut cells = Vec::new();
        for row in 0..SIZE {
            for col in 0..SIZE {
                if self.rank(row, col) == 0 {
                    cells.push((row, col));
                }
            }
        }
        cells
    }

    fn count_empty(&self) -> usize {
        let mut count = 0;
        for index in 0..CELLS {
            if self.rank_at_index(index) == 0 {
                count += 1;
            }
        }
        count
    }

    fn max_tile(&self) -> u32 {
        rank_to_tile_value(self.max_rank())
    }

    fn max_rank(&self) -> u8 {
        let mut max = 0;
        for index in 0..CELLS {
            max = max.max(self.rank_at_index(index));
        }
        max
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

const DIRECTIONS: [Direction; 4] = [
    Direction::Up,
    Direction::Down,
    Direction::Left,
    Direction::Right,
];

impl Direction {
    fn from_index(index: u8) -> Option<Self> {
        match index {
            0 => Some(Self::Up),
            1 => Some(Self::Down),
            2 => Some(Self::Left),
            3 => Some(Self::Right),
            _ => None,
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "up" => Some(Self::Up),
            "down" => Some(Self::Down),
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            _ => None,
        }
    }

    fn index(self) -> u8 {
        match self {
            Self::Up => 0,
            Self::Down => 1,
            Self::Left => 2,
            Self::Right => 3,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct SimulatedMove {
    board: Board,
    score: u32,
    moved: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveSimulationResult {
    pub board: [[u32; SIZE]; SIZE],
    pub score: u32,
    pub moved: bool,
}

impl From<SimulatedMove> for MoveSimulationResult {
    fn from(result: SimulatedMove) -> Self {
        Self {
            board: result.board.rows(),
            score: result.score,
            moved: result.moved,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HeuristicPresetName {
    Balanced,
    HighScore,
    Survival,
}

#[derive(Clone, Copy)]
struct HeuristicWeights {
    empty_linear: f64,
    empty_squared: f64,
    max_tile: f64,
    preferred_corner: f64,
    any_corner: f64,
    off_corner_penalty: f64,
    monotonicity: f64,
    smoothness: f64,
    merge_potential: f64,
    snake: f64,
    edge_stability: f64,
    isolation_penalty: f64,
    fail_no_move_penalty: f64,
    low_empty_penalty: f64,
    low_empty_merge_relief: f64,
    late_game_risk_scale: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationOptions {
    pub preferred_corner: Option<Corner>,
    pub risk_weight: Option<f64>,
    pub preset: Option<HeuristicPresetName>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindBestMoveOptions {
    pub thinking_strength: Option<f64>,
    pub use_dynamic_depth: Option<bool>,
    pub max_depth: Option<u32>,
    pub time_budget_ms: Option<f64>,
    pub heuristic_preset: Option<HeuristicPresetName>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecisionBackend {
    Cpu,
    CudaRollout,
}

#[derive(Clone, Debug)]
pub struct DecisionConfig {
    pub backend: DecisionBackend,
    pub gpu_index: u32,
    pub rollouts: Option<u32>,
    pub rollout_steps: u32,
}

impl Default for DecisionConfig {
    fn default() -> Self {
        Self {
            backend: DecisionBackend::Cpu,
            gpu_index: 0,
            rollouts: None,
            rollout_steps: DEFAULT_ROLLOUT_STEPS,
        }
    }
}

impl DecisionConfig {
    pub fn resolved_rollouts(&self, options: &FindBestMoveOptions) -> u32 {
        self.rollouts
            .unwrap_or_else(|| default_cuda_rollouts_for_options(options))
            .max(1)
    }
}

#[derive(Clone)]
struct SearchConfig {
    depth: u8,
    time_budget_ms: f64,
    chance_cell_limit: usize,
    risk_weight: f64,
    worst_case_weight: f64,
    cache_limit: usize,
    heuristic_preset: HeuristicPresetName,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMetrics {
    pub nodes: u32,
    pub cache_hits: u32,
    pub cache_misses: u32,
    pub chance_nodes: u32,
    pub duration_ms: f64,
    pub timed_out: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatedMove {
    pub direction: String,
    pub score: f64,
    pub valid: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchDecision {
    pub best_direction: Option<String>,
    pub best_score: f64,
    pub depth: u8,
    pub evaluated_moves: Vec<EvaluatedMove>,
    pub metrics: SearchMetrics,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct CacheKey {
    is_chance: bool,
    depth: u8,
    board: Board,
}

struct SearchContext {
    config: SearchConfig,
    preferred_corner: Corner,
    start_time: f64,
    cache: HashMap<CacheKey, f64>,
    metrics: SearchMetrics,
}

#[derive(Debug)]
struct SearchTimeout;

#[derive(Clone)]
struct OrderedMove {
    direction: Direction,
    board: Board,
    score: u32,
    priority: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Seed {
    Number(f64),
    String(String),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkStrategyConfig {
    pub name: String,
    pub thinking_strength: Option<f64>,
    pub use_dynamic_depth: Option<bool>,
    pub max_depth: Option<u32>,
    pub time_budget_ms: Option<f64>,
    pub heuristic_preset: Option<HeuristicPresetName>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct MoveCounts {
    pub up: u32,
    pub down: u32,
    pub left: u32,
    pub right: u32,
}

impl MoveCounts {
    fn increment(&mut self, direction: Direction) {
        match direction {
            Direction::Up => self.up += 1,
            Direction::Down => self.down += 1,
            Direction::Left => self.left += 1,
            Direction::Right => self.right += 1,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkGameResult {
    pub seed: Seed,
    pub strategy_name: String,
    pub score: u32,
    pub max_tile: u32,
    pub steps: u32,
    pub final_board: [[u32; SIZE]; SIZE],
    pub move_counts: MoveCounts,
    #[serde(rename = "reached2048")]
    pub reached_2048: bool,
    #[serde(rename = "reached4096")]
    pub reached_4096: bool,
    #[serde(rename = "reached8192")]
    pub reached_8192: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkProgress {
    pub seed: Seed,
    pub strategy_name: String,
    pub strategy_index: usize,
    pub strategy_count: usize,
    pub game_index: usize,
    pub game_count: usize,
    pub step: u32,
    pub score: u32,
    pub max_tile: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkSummary {
    pub strategy_name: String,
    pub games: usize,
    pub average_score: f64,
    pub median_score: f64,
    pub best_score: u32,
    pub average_steps: f64,
    pub best_tile: u32,
    pub reached2048_rate: f64,
    pub reached4096_rate: f64,
    pub reached8192_rate: f64,
    pub max_tile_distribution: BTreeMap<u32, u32>,
    pub results: Vec<BenchmarkGameResult>,
}

impl From<&BenchmarkStrategyConfig> for FindBestMoveOptions {
    fn from(strategy: &BenchmarkStrategyConfig) -> Self {
        Self {
            thinking_strength: strategy.thinking_strength,
            use_dynamic_depth: strategy.use_dynamic_depth,
            max_depth: strategy.max_depth,
            time_budget_ms: strategy.time_budget_ms,
            heuristic_preset: strategy.heuristic_preset,
        }
    }
}

fn parse_find_options(value: JsValue) -> Result<FindBestMoveOptions, JsValue> {
    if value.is_null() || value.is_undefined() {
        return Ok(FindBestMoveOptions::default());
    }
    serde_wasm_bindgen::from_value(value).map_err(|err| js_error(err.to_string()))
}

fn parse_evaluation_options(value: JsValue) -> Result<EvaluationOptions, JsValue> {
    if value.is_null() || value.is_undefined() {
        return Ok(EvaluationOptions::default());
    }
    serde_wasm_bindgen::from_value(value).map_err(|err| js_error(err.to_string()))
}

fn tile_value_to_rank(value: u32) -> Result<u8, String> {
    if value == 0 {
        return Ok(0);
    }
    if value == 1 || !value.is_power_of_two() {
        return Err(format!(
            "tile values must be powers of two >= 2, got {value}"
        ));
    }

    let rank = value.trailing_zeros() as u8;
    if rank > MAX_TILE_EXPONENT {
        return Err(format!(
            "tile value {value} exceeds the 64-bit engine limit of {}",
            rank_to_tile_value(MAX_TILE_EXPONENT)
        ));
    }
    Ok(rank)
}

fn rank_to_tile_value(rank: u8) -> u32 {
    if rank == 0 {
        0
    } else {
        1_u32 << rank
    }
}

fn row_rank(row: u16, index: usize) -> u8 {
    ((row >> (index * 4)) & 0xF) as u8
}

fn pack_row(ranks: [u8; SIZE]) -> u16 {
    let mut row = 0_u16;
    for (index, rank) in ranks.into_iter().enumerate() {
        row |= (rank as u16) << (index * 4);
    }
    row
}

fn reverse_row(row: u16) -> u16 {
    pack_row([
        row_rank(row, 3),
        row_rank(row, 2),
        row_rank(row, 1),
        row_rank(row, 0),
    ])
}

#[derive(Clone, Copy, Debug, Default)]
struct RowMove {
    row: u16,
    score: u32,
}

fn left_row_move(row: u16) -> RowMove {
    left_row_table()[row as usize]
}

fn right_row_move(row: u16) -> RowMove {
    let reversed = reverse_row(row);
    let moved = left_row_move(reversed);
    RowMove {
        row: reverse_row(moved.row),
        score: moved.score,
    }
}

fn left_row_table() -> &'static [RowMove] {
    use std::sync::OnceLock;

    static TABLE: OnceLock<Vec<RowMove>> = OnceLock::new();
    TABLE.get_or_init(|| {
        (0..ROW_TABLE_SIZE)
            .map(|row| compute_left_row_move(row as u16))
            .collect()
    })
}

fn compute_left_row_move(row: u16) -> RowMove {
    let mut tiles = [0_u8; SIZE];
    let mut tile_count = 0;
    for index in 0..SIZE {
        let rank = row_rank(row, index);
        if rank != 0 {
            tiles[tile_count] = rank;
            tile_count += 1;
        }
    }

    let mut output = [0_u8; SIZE];
    let mut score = 0_u32;
    let mut read = 0;
    let mut write = 0;

    while read < tile_count {
        if read + 1 < tile_count && tiles[read] == tiles[read + 1] {
            let merged = tiles[read].saturating_add(1).min(MAX_TILE_EXPONENT);
            output[write] = merged;
            score = score.saturating_add(rank_to_tile_value(merged));
            read += 2;
        } else {
            output[write] = tiles[read];
            read += 1;
        }
        write += 1;
    }

    RowMove {
        row: pack_row(output),
        score,
    }
}

fn simulate_move(board: Board, direction: Direction) -> SimulatedMove {
    let mut next = board;
    let mut total_score = 0;
    let mut moved = false;

    match direction {
        Direction::Left => {
            for row in 0..SIZE {
                let old = next.row_key(row);
                let row_move = left_row_move(old);
                if row_move.row != old {
                    moved = true;
                }
                next.set_row_key(row, row_move.row);
                total_score += row_move.score;
            }
        }
        Direction::Right => {
            for row in 0..SIZE {
                let old = next.row_key(row);
                let row_move = right_row_move(old);
                if row_move.row != old {
                    moved = true;
                }
                next.set_row_key(row, row_move.row);
                total_score += row_move.score;
            }
        }
        Direction::Up => {
            for col in 0..SIZE {
                let old = next.column_key(col);
                let col_move = left_row_move(old);
                if col_move.row != old {
                    moved = true;
                }
                next.set_column_key(col, col_move.row);
                total_score += col_move.score;
            }
        }
        Direction::Down => {
            for col in 0..SIZE {
                let old = next.column_key(col);
                let col_move = right_row_move(old);
                if col_move.row != old {
                    moved = true;
                }
                next.set_column_key(col, col_move.row);
                total_score += col_move.score;
            }
        }
    }

    SimulatedMove {
        board: next,
        score: total_score,
        moved,
    }
}

fn can_move(board: &Board) -> bool {
    DIRECTIONS
        .iter()
        .any(|direction| simulate_move(*board, *direction).moved)
}

fn is_game_over(board: &Board) -> bool {
    !can_move(board)
}

fn heuristic_weights(preset: HeuristicPresetName) -> HeuristicWeights {
    match preset {
        HeuristicPresetName::Balanced => HeuristicWeights {
            empty_linear: 250.0,
            empty_squared: 120.0,
            max_tile: 0.35,
            preferred_corner: 5.0,
            any_corner: 1.5,
            off_corner_penalty: 3.0,
            monotonicity: 120.0,
            smoothness: 45.0,
            merge_potential: 90.0,
            snake: 130.0,
            edge_stability: 30.0,
            isolation_penalty: 55.0,
            fail_no_move_penalty: 120000.0,
            low_empty_penalty: 3500.0,
            low_empty_merge_relief: 900.0,
            late_game_risk_scale: 1.0,
        },
        HeuristicPresetName::HighScore => HeuristicWeights {
            empty_linear: 300.0,
            empty_squared: 145.0,
            max_tile: 0.45,
            preferred_corner: 6.5,
            any_corner: 1.2,
            off_corner_penalty: 4.5,
            monotonicity: 150.0,
            smoothness: 38.0,
            merge_potential: 110.0,
            snake: 170.0,
            edge_stability: 34.0,
            isolation_penalty: 70.0,
            fail_no_move_penalty: 150000.0,
            low_empty_penalty: 4200.0,
            low_empty_merge_relief: 1000.0,
            late_game_risk_scale: 1.15,
        },
        HeuristicPresetName::Survival => HeuristicWeights {
            empty_linear: 380.0,
            empty_squared: 180.0,
            max_tile: 0.25,
            preferred_corner: 5.5,
            any_corner: 1.4,
            off_corner_penalty: 5.2,
            monotonicity: 125.0,
            smoothness: 55.0,
            merge_potential: 135.0,
            snake: 115.0,
            edge_stability: 42.0,
            isolation_penalty: 90.0,
            fail_no_move_penalty: 180000.0,
            low_empty_penalty: 7000.0,
            low_empty_merge_relief: 1500.0,
            late_game_risk_scale: 1.65,
        },
    }
}

fn choose_preferred_corner(board: &Board) -> Corner {
    let max = board.max_tile();
    let corners = [
        (Corner::TopLeft, board.get(0, 0)),
        (Corner::TopRight, board.get(0, SIZE - 1)),
        (Corner::BottomLeft, board.get(SIZE - 1, 0)),
        (Corner::BottomRight, board.get(SIZE - 1, SIZE - 1)),
    ];

    if let Some((corner, _)) = corners.iter().find(|(_, value)| *value == max) {
        return *corner;
    }

    let mut best_corner = Corner::TopLeft;
    let mut best_score = f64::NEG_INFINITY;
    for variant in snake_variants() {
        let score = score_snake_variant(board, &variant.weights);
        if score > best_score {
            best_score = score;
            best_corner = variant.corner;
        }
    }
    best_corner
}

fn evaluate(board: &Board, options: &EvaluationOptions) -> f64 {
    let preferred_corner = options
        .preferred_corner
        .unwrap_or_else(|| choose_preferred_corner(board));
    let risk_weight = options.risk_weight.unwrap_or(1.0);
    let weights = heuristic_weights(options.preset.unwrap_or(DEFAULT_PRESET));

    empty_bonus(board, &weights)
        + max_tile_bonus(board, &weights)
        + corner_stability(board, preferred_corner, risk_weight, &weights)
        + monotonicity_score(board, &weights)
        + smoothness_score(board, &weights)
        + merge_potential(board, &weights)
        + snake_weight(board, preferred_corner, &weights)
        + edge_stability(board, &weights)
        + isolation_penalty(board, risk_weight, &weights)
        + failure_risk_penalty(board, risk_weight, &weights)
}

fn empty_bonus(board: &Board, weights: &HeuristicWeights) -> f64 {
    let empty = board.count_empty() as f64;
    empty * weights.empty_linear + empty * empty * weights.empty_squared
}

fn max_tile_bonus(board: &Board, weights: &HeuristicWeights) -> f64 {
    let max_rank = board.max_rank();
    if max_rank > 0 {
        max_rank as f64 * rank_to_tile_value(max_rank) as f64 * weights.max_tile
    } else {
        0.0
    }
}

fn corner_stability(
    board: &Board,
    preferred_corner: Corner,
    risk_weight: f64,
    weights: &HeuristicWeights,
) -> f64 {
    let max = board.max_tile();
    let max_corner = corner_for_value(board, max);
    if max_corner == Some(preferred_corner) {
        max as f64 * weights.preferred_corner
    } else if max_corner.is_some() {
        max as f64 * weights.any_corner
    } else {
        -(max as f64) * weights.off_corner_penalty * risk_weight
    }
}

fn monotonicity_score(board: &Board, weights: &HeuristicWeights) -> f64 {
    let mut score = 0.0;

    for row in 0..SIZE {
        let mut inc_score = 0.0;
        let mut dec_score = 0.0;
        for col in 0..SIZE - 1 {
            let a = board.rank(row, col) as f64;
            let b = board.rank(row, col + 1) as f64;
            if a > b {
                inc_score += b - a;
            } else {
                dec_score += a - b;
            }
        }
        score += inc_score.max(dec_score);
    }

    for col in 0..SIZE {
        let mut inc_score = 0.0;
        let mut dec_score = 0.0;
        for row in 0..SIZE - 1 {
            let a = board.rank(row, col) as f64;
            let b = board.rank(row + 1, col) as f64;
            if a > b {
                inc_score += b - a;
            } else {
                dec_score += a - b;
            }
        }
        score += inc_score.max(dec_score);
    }

    score * weights.monotonicity
}

fn smoothness_score(board: &Board, weights: &HeuristicWeights) -> f64 {
    let mut penalty = 0.0;

    for row in 0..SIZE {
        for col in 0..SIZE {
            if board.rank(row, col) == 0 {
                continue;
            }

            let current = board.rank(row, col) as f64;
            if col + 1 < SIZE && board.rank(row, col + 1) != 0 {
                penalty -= (current - board.rank(row, col + 1) as f64).abs();
            }
            if row + 1 < SIZE && board.rank(row + 1, col) != 0 {
                penalty -= (current - board.rank(row + 1, col) as f64).abs();
            }
        }
    }

    penalty * weights.smoothness
}

fn merge_potential(board: &Board, weights: &HeuristicWeights) -> f64 {
    let mut score = 0.0;

    for row in 0..SIZE {
        for col in 0..SIZE {
            let rank = board.rank(row, col);
            if rank == 0 {
                continue;
            }

            if col + 1 < SIZE && rank == board.rank(row, col + 1) {
                score += rank as f64 * weights.merge_potential;
            }
            if row + 1 < SIZE && rank == board.rank(row + 1, col) {
                score += rank as f64 * weights.merge_potential;
            }
        }
    }

    score
}

fn snake_weight(board: &Board, preferred_corner: Corner, weights: &HeuristicWeights) -> f64 {
    let mut best = f64::NEG_INFINITY;
    let variants = snake_variants();
    let mut found_preferred = false;

    for variant in variants
        .iter()
        .filter(|variant| variant.corner == preferred_corner)
    {
        found_preferred = true;
        best = best.max(score_snake_variant(board, &variant.weights));
    }

    if !found_preferred {
        for variant in variants {
            best = best.max(score_snake_variant(board, &variant.weights));
        }
    }

    best * weights.snake
}

fn edge_stability(board: &Board, weights: &HeuristicWeights) -> f64 {
    let mut score = 0.0;

    for row in 0..SIZE {
        for col in 0..SIZE {
            if row == 0 || row == SIZE - 1 || col == 0 || col == SIZE - 1 {
                score += board.rank(row, col) as f64 * weights.edge_stability;
            }
        }
    }

    score
}

fn isolation_penalty(board: &Board, risk_weight: f64, weights: &HeuristicWeights) -> f64 {
    let mut penalty = 0.0;

    for row in 0..SIZE {
        for col in 0..SIZE {
            let rank = board.rank(row, col);
            if rank == 0 {
                continue;
            }

            let current = rank as f64;
            let has_friendly_neighbor = neighbors(board, row, col)
                .iter()
                .any(|neighbor| *neighbor == 0 || (current - *neighbor as f64).abs() <= 1.0);

            if !has_friendly_neighbor {
                penalty -= current * weights.isolation_penalty * risk_weight;
            }
        }
    }

    penalty
}

fn failure_risk_penalty(board: &Board, risk_weight: f64, weights: &HeuristicWeights) -> f64 {
    let empty = board.count_empty();
    let merges = count_merge_opportunities(board) as f64;
    let late_scale = if empty <= 4 {
        weights.late_game_risk_scale
    } else {
        1.0
    };

    if empty == 0 && merges == 0.0 {
        return -weights.fail_no_move_penalty * risk_weight * late_scale;
    }
    if empty <= 1 {
        return (-weights.low_empty_penalty * 3.4 + merges * weights.low_empty_merge_relief * 1.7)
            * risk_weight
            * late_scale;
    }
    if empty <= 3 {
        return (-weights.low_empty_penalty + merges * weights.low_empty_merge_relief)
            * risk_weight
            * late_scale;
    }
    if empty <= 5 {
        return (-weights.low_empty_penalty * 0.2 + merges * weights.low_empty_merge_relief * 0.28)
            * risk_weight
            * late_scale;
    }

    merges * weights.low_empty_merge_relief * 0.13
}

fn count_merge_opportunities(board: &Board) -> u32 {
    let mut count = 0;
    for row in 0..SIZE {
        for col in 0..SIZE {
            let rank = board.rank(row, col);
            if rank == 0 {
                continue;
            }
            if col + 1 < SIZE && rank == board.rank(row, col + 1) {
                count += 1;
            }
            if row + 1 < SIZE && rank == board.rank(row + 1, col) {
                count += 1;
            }
        }
    }
    count
}

fn neighbors(board: &Board, row: usize, col: usize) -> Vec<u8> {
    let mut values = Vec::with_capacity(4);
    if row > 0 {
        values.push(board.rank(row - 1, col));
    }
    if row + 1 < SIZE {
        values.push(board.rank(row + 1, col));
    }
    if col > 0 {
        values.push(board.rank(row, col - 1));
    }
    if col + 1 < SIZE {
        values.push(board.rank(row, col + 1));
    }
    values
}

fn corner_for_value(board: &Board, value: u32) -> Option<Corner> {
    [
        (Corner::TopLeft, board.get(0, 0)),
        (Corner::TopRight, board.get(0, SIZE - 1)),
        (Corner::BottomLeft, board.get(SIZE - 1, 0)),
        (Corner::BottomRight, board.get(SIZE - 1, SIZE - 1)),
    ]
    .iter()
    .find(|(_, corner_value)| *corner_value == value)
    .map(|(corner, _)| *corner)
}

#[derive(Clone, Copy)]
struct SnakeVariant {
    corner: Corner,
    weights: [[u8; SIZE]; SIZE],
}

fn snake_variants() -> &'static Vec<SnakeVariant> {
    use std::sync::OnceLock;

    static VARIANTS: OnceLock<Vec<SnakeVariant>> = OnceLock::new();
    VARIANTS.get_or_init(build_snake_variants)
}

fn build_snake_variants() -> Vec<SnakeVariant> {
    let mut variants = Vec::new();
    let mut seen = HashSet::new();
    let mut current = [[15, 14, 13, 12], [8, 9, 10, 11], [7, 6, 5, 4], [0, 1, 2, 3]];

    for _ in 0..4 {
        for weights in [current, mirror_matrix(current)] {
            if seen.insert(weights) {
                variants.push(SnakeVariant {
                    corner: strongest_weight_corner(&weights),
                    weights,
                });
            }
        }
        current = rotate_matrix(current);
    }

    variants
}

fn rotate_matrix(matrix: [[u8; SIZE]; SIZE]) -> [[u8; SIZE]; SIZE] {
    let mut rotated = [[0; SIZE]; SIZE];
    for row in 0..SIZE {
        for col in 0..SIZE {
            rotated[row][col] = matrix[SIZE - 1 - col][row];
        }
    }
    rotated
}

fn mirror_matrix(matrix: [[u8; SIZE]; SIZE]) -> [[u8; SIZE]; SIZE] {
    let mut mirrored = [[0; SIZE]; SIZE];
    for row in 0..SIZE {
        for col in 0..SIZE {
            mirrored[row][col] = matrix[row][SIZE - 1 - col];
        }
    }
    mirrored
}

fn strongest_weight_corner(weights: &[[u8; SIZE]; SIZE]) -> Corner {
    let mut corners = [
        (Corner::TopLeft, weights[0][0]),
        (Corner::TopRight, weights[0][SIZE - 1]),
        (Corner::BottomLeft, weights[SIZE - 1][0]),
        (Corner::BottomRight, weights[SIZE - 1][SIZE - 1]),
    ];
    corners.sort_by(|a, b| b.1.cmp(&a.1));
    corners[0].0
}

fn score_snake_variant(board: &Board, weights: &[[u8; SIZE]; SIZE]) -> f64 {
    let mut score = 0.0;
    for row in 0..SIZE {
        for col in 0..SIZE {
            score += board.rank(row, col) as f64 * weights[row][col] as f64;
        }
    }
    score
}

fn normalize_thinking_strength(value: f64) -> u32 {
    if !value.is_finite() {
        return DEFAULT_THINKING_STRENGTH;
    }
    clamp_u32(value.round() as u32, 1, 10)
}

pub fn default_cuda_rollouts_for_options(options: &FindBestMoveOptions) -> u32 {
    let strength = normalize_thinking_strength(
        options
            .thinking_strength
            .unwrap_or(DEFAULT_THINKING_STRENGTH as f64),
    );
    default_cuda_rollouts_for_strength(strength)
}

fn default_cuda_rollouts_for_strength(strength: u32) -> u32 {
    match clamp_u32(strength, 1, 10) {
        1 => 512,
        2 => 1024,
        3 => 2048,
        4 => 4096,
        5 => 8192,
        6 => 12288,
        7 => 16384,
        8 => 32768,
        9 => 49152,
        _ => 65536,
    }
}

fn derive_search_config(
    thinking_strength: f64,
    empty_cells: usize,
    use_dynamic_depth: bool,
    heuristic_preset: HeuristicPresetName,
) -> SearchConfig {
    let strength = normalize_thinking_strength(thinking_strength);
    let empty = clamp_u32(empty_cells as u32, 0, 16);

    let mut depth = if strength <= 2 {
        1
    } else if strength <= 4 {
        2
    } else if strength <= 6 {
        3
    } else if strength <= 8 {
        4
    } else {
        5
    };

    if use_dynamic_depth {
        if empty <= 2 {
            depth += 2;
        } else if empty <= 4 {
            depth += 1;
        } else if empty >= 10 {
            depth -= 1;
        }
    }

    let time_budget_ms = 45.0 + (strength * strength * 6) as f64;

    let chance_cell_limit = if strength >= 9 {
        16
    } else if strength <= 2 {
        3
    } else if strength <= 4 {
        4
    } else if strength <= 6 {
        6
    } else {
        8
    };

    SearchConfig {
        depth: clamp_u32(depth, 1, MAX_SEARCH_DEPTH) as u8,
        time_budget_ms,
        chance_cell_limit,
        risk_weight: 0.75 + strength as f64 * 0.08,
        worst_case_weight: if strength <= 3 {
            0.02
        } else if strength <= 6 {
            0.06
        } else {
            0.1
        },
        cache_limit: 8000 + strength as usize * 5000,
        heuristic_preset,
    }
}

fn resolve_search_config(board: &Board, options: &FindBestMoveOptions) -> SearchConfig {
    let use_dynamic_depth = options.use_dynamic_depth.unwrap_or(true);
    let heuristic_preset = options.heuristic_preset.unwrap_or(DEFAULT_PRESET);
    let config = derive_search_config(
        options
            .thinking_strength
            .unwrap_or(DEFAULT_THINKING_STRENGTH as f64),
        board.count_empty(),
        use_dynamic_depth,
        heuristic_preset,
    );

    SearchConfig {
        depth: if use_dynamic_depth {
            config.depth
        } else {
            clamp_u32(
                options.max_depth.unwrap_or(config.depth as u32),
                1,
                MAX_SEARCH_DEPTH,
            ) as u8
        },
        time_budget_ms: options.time_budget_ms.unwrap_or(config.time_budget_ms),
        ..config
    }
}

fn select_chance_cells_for_search(
    board: &Board,
    config: &SearchConfig,
    preferred_corner: Corner,
) -> Vec<(usize, usize)> {
    let mut ranked: Vec<(usize, usize, f64)> = board
        .empty_cells()
        .into_iter()
        .map(|(row, col)| {
            let board2 = board.spawn(row, col, 2);
            let board4 = board.spawn(row, col, 4);
            let score = evaluate(
                &board2,
                &EvaluationOptions {
                    preferred_corner: Some(preferred_corner),
                    risk_weight: Some(config.risk_weight),
                    preset: Some(config.heuristic_preset),
                },
            )
            .min(evaluate(
                &board4,
                &EvaluationOptions {
                    preferred_corner: Some(preferred_corner),
                    risk_weight: Some(config.risk_weight),
                    preset: Some(config.heuristic_preset),
                },
            ));
            (row, col, score)
        })
        .collect();

    ranked.sort_by(|a, b| {
        a.2.partial_cmp(&b.2)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
            .then_with(|| a.1.cmp(&b.1))
    });

    ranked
        .into_iter()
        .take(config.chance_cell_limit)
        .map(|(row, col, _)| (row, col))
        .collect()
}

fn find_best_move_with_decision_config(
    board: Board,
    options: &FindBestMoveOptions,
    decision_config: &DecisionConfig,
) -> Result<Option<SearchDecision>, String> {
    match decision_config.backend {
        DecisionBackend::Cpu => Ok(find_best_move_core(board, options)),
        DecisionBackend::CudaRollout => {
            cuda_rollout::find_best_move_cuda_rollout(board, options, decision_config)
        }
    }
}

fn find_best_move_core(board: Board, options: &FindBestMoveOptions) -> Option<SearchDecision> {
    let config = resolve_search_config(&board, options);
    let preferred_corner = choose_preferred_corner(&board);
    let start_time = now_ms();
    let cache_capacity = config.cache_limit.min(1 << 20);
    let mut context = SearchContext {
        config,
        preferred_corner,
        start_time,
        cache: HashMap::with_capacity(cache_capacity),
        metrics: SearchMetrics::default(),
    };

    let mut best_completed = None;
    for depth in 1..=context.config.depth {
        match evaluate_root_moves(&board, depth, &mut context) {
            Ok(decision) => best_completed = Some(decision),
            Err(SearchTimeout) => break,
        }
    }

    let mut decision = best_completed
        .or_else(|| evaluate_immediate_moves(&board, &context.config, context.preferred_corner))?;
    decision.metrics = SearchMetrics {
        duration_ms: now_ms() - context.start_time,
        ..context.metrics
    };
    Some(decision)
}

fn evaluate_root_moves(
    board: &Board,
    depth: u8,
    context: &mut SearchContext,
) -> Result<SearchDecision, SearchTimeout> {
    let mut evaluated = default_evaluated_moves();
    let mut best_direction = None;
    let mut best_score = f64::NEG_INFINITY;

    for ordered_move in order_moves(board, &context.config, context.preferred_corner) {
        check_timeout(context)?;
        let score =
            ordered_move.score as f64 + expectimax(&ordered_move.board, depth, true, context)?;
        evaluated[ordered_move.direction.index() as usize] = EvaluatedMove {
            direction: ordered_move.direction.as_str().to_string(),
            score,
            valid: true,
        };

        if score > best_score {
            best_score = score;
            best_direction = Some(ordered_move.direction.as_str().to_string());
        }
    }

    Ok(SearchDecision {
        best_direction,
        best_score,
        depth,
        evaluated_moves: evaluated,
        metrics: context.metrics.clone(),
    })
}

fn evaluate_immediate_moves(
    board: &Board,
    config: &SearchConfig,
    preferred_corner: Corner,
) -> Option<SearchDecision> {
    let mut evaluated = default_evaluated_moves();
    let mut best_direction = None;
    let mut best_score = f64::NEG_INFINITY;

    for direction in DIRECTIONS {
        let result = simulate_move(*board, direction);
        if !result.moved {
            continue;
        }

        let score = result.score as f64
            + evaluate(
                &result.board,
                &EvaluationOptions {
                    preferred_corner: Some(preferred_corner),
                    risk_weight: Some(config.risk_weight),
                    preset: Some(config.heuristic_preset),
                },
            );

        evaluated[direction.index() as usize] = EvaluatedMove {
            direction: direction.as_str().to_string(),
            score,
            valid: true,
        };
        if score > best_score {
            best_score = score;
            best_direction = Some(direction.as_str().to_string());
        }
    }

    best_direction.as_ref()?;
    Some(SearchDecision {
        best_direction,
        best_score,
        depth: 0,
        evaluated_moves: evaluated,
        metrics: SearchMetrics::default(),
    })
}

fn default_evaluated_moves() -> Vec<EvaluatedMove> {
    DIRECTIONS
        .iter()
        .map(|direction| EvaluatedMove {
            direction: direction.as_str().to_string(),
            score: f64::NEG_INFINITY,
            valid: false,
        })
        .collect()
}

fn expectimax(
    board: &Board,
    depth: u8,
    is_chance: bool,
    context: &mut SearchContext,
) -> Result<f64, SearchTimeout> {
    check_timeout(context)?;
    context.metrics.nodes = context.metrics.nodes.saturating_add(1);

    let cache_key = CacheKey {
        is_chance,
        depth,
        board: *board,
    };
    if let Some(value) = context.cache.get(&cache_key) {
        context.metrics.cache_hits = context.metrics.cache_hits.saturating_add(1);
        return Ok(*value);
    }
    context.metrics.cache_misses = context.metrics.cache_misses.saturating_add(1);

    let value = if depth == 0 || is_game_over(board) {
        evaluate_board_with_context(board, context)
    } else if is_chance {
        evaluate_chance_node(board, depth, context)?
    } else {
        evaluate_max_node(board, depth, context)?
    };

    if context.cache.len() < context.config.cache_limit {
        context.cache.insert(cache_key, value);
    }

    Ok(value)
}

fn evaluate_max_node(
    board: &Board,
    depth: u8,
    context: &mut SearchContext,
) -> Result<f64, SearchTimeout> {
    let mut best = f64::NEG_INFINITY;

    for ordered_move in order_moves(board, &context.config, context.preferred_corner) {
        check_timeout(context)?;
        let score =
            ordered_move.score as f64 + expectimax(&ordered_move.board, depth, true, context)?;
        if score > best {
            best = score;
        }
    }

    if best == f64::NEG_INFINITY {
        Ok(evaluate_board_with_context(board, context))
    } else {
        Ok(best)
    }
}

fn evaluate_chance_node(
    board: &Board,
    depth: u8,
    context: &mut SearchContext,
) -> Result<f64, SearchTimeout> {
    context.metrics.chance_nodes = context.metrics.chance_nodes.saturating_add(1);
    let cells = select_chance_cells_for_search(board, &context.config, context.preferred_corner);
    if cells.is_empty() {
        return Ok(evaluate_board_with_context(board, context));
    }

    let mut total = 0.0;
    let mut worst = f64::INFINITY;

    for (row, col) in cells.iter().copied() {
        check_timeout(context)?;
        let score2 = expectimax(&board.spawn(row, col, 2), depth - 1, false, context)?;
        let score4 = expectimax(&board.spawn(row, col, 4), depth - 1, false, context)?;
        let expected = PROB_2 * score2 + PROB_4 * score4;
        total += expected;
        worst = worst.min(expected);
    }

    let expected_average = total / cells.len() as f64;
    Ok(expected_average * (1.0 - context.config.worst_case_weight)
        + worst * context.config.worst_case_weight)
}

fn order_moves(board: &Board, config: &SearchConfig, preferred_corner: Corner) -> Vec<OrderedMove> {
    let mut moves: Vec<OrderedMove> = DIRECTIONS
        .iter()
        .filter_map(|direction| {
            let result = simulate_move(*board, *direction);
            if !result.moved {
                return None;
            }

            let priority = result.score as f64 * 4.0
                + result.board.count_empty() as f64 * 220.0
                + evaluate(
                    &result.board,
                    &EvaluationOptions {
                        preferred_corner: Some(preferred_corner),
                        risk_weight: Some(config.risk_weight),
                        preset: Some(config.heuristic_preset),
                    },
                ) * 0.02;

            Some(OrderedMove {
                direction: *direction,
                board: result.board,
                score: result.score,
                priority,
            })
        })
        .collect();

    moves.sort_by(|a, b| {
        b.priority
            .partial_cmp(&a.priority)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.direction.index().cmp(&b.direction.index()))
    });
    moves
}

fn evaluate_board_with_context(board: &Board, context: &SearchContext) -> f64 {
    evaluate(
        board,
        &EvaluationOptions {
            preferred_corner: Some(context.preferred_corner),
            risk_weight: Some(context.config.risk_weight),
            preset: Some(context.config.heuristic_preset),
        },
    )
}

fn check_timeout(context: &mut SearchContext) -> Result<(), SearchTimeout> {
    if !context.config.time_budget_ms.is_finite() {
        return Ok(());
    }

    if now_ms() - context.start_time > context.config.time_budget_ms {
        context.metrics.timed_out = true;
        Err(SearchTimeout)
    } else {
        Ok(())
    }
}

fn run_benchmark_core(
    seeds: &[Seed],
    strategies: &[BenchmarkStrategyConfig],
    max_moves: Option<u32>,
) -> Vec<BenchmarkSummary> {
    let mut ignore_progress = ignore_benchmark_progress;
    run_benchmark_core_with_progress_and_decision_config(
        seeds,
        strategies,
        max_moves,
        &DecisionConfig::default(),
        &mut ignore_progress,
    )
    .expect("cpu benchmark backend cannot fail")
}

fn run_benchmark_core_with_progress(
    seeds: &[Seed],
    strategies: &[BenchmarkStrategyConfig],
    max_moves: Option<u32>,
    on_progress: &mut dyn FnMut(&BenchmarkProgress),
) -> Vec<BenchmarkSummary> {
    run_benchmark_core_with_progress_and_decision_config(
        seeds,
        strategies,
        max_moves,
        &DecisionConfig::default(),
        on_progress,
    )
    .expect("cpu benchmark backend cannot fail")
}

fn run_benchmark_core_with_progress_and_decision_config(
    seeds: &[Seed],
    strategies: &[BenchmarkStrategyConfig],
    max_moves: Option<u32>,
    decision_config: &DecisionConfig,
    on_progress: &mut dyn FnMut(&BenchmarkProgress),
) -> Result<Vec<BenchmarkSummary>, String> {
    let strategy_count = strategies.len();
    let game_count = seeds.len();

    strategies
        .iter()
        .enumerate()
        .map(|(strategy_index, strategy)| {
            let results: Vec<BenchmarkGameResult> = seeds
                .iter()
                .enumerate()
                .map(|(game_index, seed)| {
                    run_benchmark_game_with_progress(
                        seed.clone(),
                        strategy,
                        max_moves.unwrap_or(2000),
                        decision_config,
                        ProgressScope {
                            strategy_index,
                            strategy_count,
                            game_index,
                            game_count,
                        },
                        on_progress,
                    )
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(summarize_results(strategy.name.clone(), results))
        })
        .collect()
}

fn run_benchmark_game(
    seed: Seed,
    strategy: &BenchmarkStrategyConfig,
    max_moves: u32,
) -> BenchmarkGameResult {
    let mut ignore_progress = ignore_benchmark_progress;
    run_benchmark_game_with_progress(
        seed,
        strategy,
        max_moves,
        &DecisionConfig::default(),
        ProgressScope {
            strategy_index: 0,
            strategy_count: 1,
            game_index: 0,
            game_count: 1,
        },
        &mut ignore_progress,
    )
    .expect("cpu benchmark backend cannot fail")
}

fn run_benchmark_game_with_decision_config(
    seed: Seed,
    strategy: &BenchmarkStrategyConfig,
    max_moves: u32,
    decision_config: &DecisionConfig,
) -> Result<BenchmarkGameResult, String> {
    let mut ignore_progress = ignore_benchmark_progress;
    run_benchmark_game_with_progress(
        seed,
        strategy,
        max_moves,
        decision_config,
        ProgressScope {
            strategy_index: 0,
            strategy_count: 1,
            game_index: 0,
            game_count: 1,
        },
        &mut ignore_progress,
    )
}

fn ignore_benchmark_progress(_: &BenchmarkProgress) {}

#[derive(Clone, Copy)]
struct ProgressScope {
    strategy_index: usize,
    strategy_count: usize,
    game_index: usize,
    game_count: usize,
}

fn run_benchmark_game_with_progress(
    seed: Seed,
    strategy: &BenchmarkStrategyConfig,
    max_moves: u32,
    decision_config: &DecisionConfig,
    progress_scope: ProgressScope,
    on_progress: &mut dyn FnMut(&BenchmarkProgress),
) -> Result<BenchmarkGameResult, String> {
    let mut rng = SeededRandom::new(&seed);
    let mut move_counts = MoveCounts::default();
    let mut board = Board::empty();
    board = spawn_random_tile(board, &mut rng);
    board = spawn_random_tile(board, &mut rng);

    let mut score = 0;
    let mut steps = 0;
    let options = FindBestMoveOptions::from(strategy);

    while !is_game_over(&board) && steps < max_moves {
        let Some(decision) = find_best_move_with_decision_config(board, &options, decision_config)?
        else {
            break;
        };
        let Some(direction_name) = decision.best_direction else {
            break;
        };
        let Some(direction) = direction_from_name(&direction_name) else {
            break;
        };

        let result = simulate_move(board, direction);
        if !result.moved {
            break;
        }

        board = result.board;
        score += result.score;
        move_counts.increment(direction);

        if !board.empty_cells().is_empty() {
            board = spawn_random_tile(board, &mut rng);
        }
        steps += 1;

        on_progress(&BenchmarkProgress {
            seed: seed.clone(),
            strategy_name: strategy.name.clone(),
            strategy_index: progress_scope.strategy_index,
            strategy_count: progress_scope.strategy_count,
            game_index: progress_scope.game_index,
            game_count: progress_scope.game_count,
            step: steps,
            score,
            max_tile: board.max_tile(),
        });
    }

    let max_tile = board.max_tile();
    Ok(BenchmarkGameResult {
        seed,
        strategy_name: strategy.name.clone(),
        score,
        max_tile,
        steps,
        final_board: board.rows(),
        move_counts,
        reached_2048: max_tile >= 2048,
        reached_4096: max_tile >= 4096,
        reached_8192: max_tile >= 8192,
    })
}

fn summarize_results(strategy_name: String, results: Vec<BenchmarkGameResult>) -> BenchmarkSummary {
    let mut scores: Vec<u32> = results.iter().map(|result| result.score).collect();
    scores.sort_unstable();
    let games = results.len();
    let mut max_tile_distribution = BTreeMap::new();

    for result in &results {
        *max_tile_distribution.entry(result.max_tile).or_insert(0) += 1;
    }

    BenchmarkSummary {
        strategy_name,
        games,
        average_score: average_u32(&scores),
        median_score: median_u32(&scores),
        best_score: scores.iter().copied().max().unwrap_or(0),
        average_steps: average_u32(
            &results
                .iter()
                .map(|result| result.steps)
                .collect::<Vec<_>>(),
        ),
        best_tile: results
            .iter()
            .map(|result| result.max_tile)
            .max()
            .unwrap_or(0),
        reached2048_rate: rate(&results, |result| result.reached_2048),
        reached4096_rate: rate(&results, |result| result.reached_4096),
        reached8192_rate: rate(&results, |result| result.reached_8192),
        max_tile_distribution,
        results,
    }
}

fn spawn_random_tile(board: Board, rng: &mut SeededRandom) -> Board {
    let empty = board.empty_cells();
    if empty.is_empty() {
        return board;
    }

    let index = (rng.next() * empty.len() as f64).floor() as usize;
    let (row, col) = empty[index.min(empty.len() - 1)];
    let value = if rng.next() < 0.9 { 2 } else { 4 };
    board.spawn(row, col, value)
}

struct SeededRandom {
    state: u32,
}

impl SeededRandom {
    fn new(seed: &Seed) -> Self {
        Self {
            state: normalize_seed(seed),
        }
    }

    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = (self.state ^ (self.state >> 15)).wrapping_mul(1 | self.state);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

fn normalize_seed(seed: &Seed) -> u32 {
    match seed {
        Seed::Number(value) => to_uint32(*value),
        Seed::String(value) => {
            let mut hash = 2166136261_u32;
            for code_unit in value.encode_utf16() {
                hash ^= code_unit as u32;
                hash = hash.wrapping_mul(16777619);
            }
            hash
        }
    }
}

fn to_uint32(value: f64) -> u32 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    value.trunc().rem_euclid(4294967296.0) as u32
}

fn direction_from_name(name: &str) -> Option<Direction> {
    match name {
        "up" => Some(Direction::Up),
        "down" => Some(Direction::Down),
        "left" => Some(Direction::Left),
        "right" => Some(Direction::Right),
        _ => None,
    }
}

fn average_u32(values: &[u32]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().map(|value| *value as f64).sum::<f64>() / values.len() as f64
}

fn median_u32(sorted_values: &[u32]) -> f64 {
    if sorted_values.is_empty() {
        return 0.0;
    }

    let mid = sorted_values.len() / 2;
    if sorted_values.len() % 2 == 1 {
        sorted_values[mid] as f64
    } else {
        (sorted_values[mid - 1] as f64 + sorted_values[mid] as f64) / 2.0
    }
}

fn rate(results: &[BenchmarkGameResult], predicate: impl Fn(&BenchmarkGameResult) -> bool) -> f64 {
    if results.is_empty() {
        return 0.0;
    }
    results.iter().filter(|result| predicate(result)).count() as f64 / results.len() as f64
}

fn clamp_u32(value: u32, min: u32, max: u32) -> u32 {
    value.min(max).max(min)
}

fn js_error(message: impl AsRef<str>) -> JsValue {
    JsValue::from_str(message.as_ref())
}

#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    js_sys::Date::now()
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board(values: [[u32; SIZE]; SIZE]) -> Board {
        let mut flat = [0; CELLS];
        for row in 0..SIZE {
            for col in 0..SIZE {
                flat[row * SIZE + col] = values[row][col];
            }
        }
        Board::from_values(&flat).expect("valid test board")
    }

    #[test]
    fn simulates_moves_in_all_directions() {
        let base = board([[2, 2, 2, 2], [0, 0, 0, 0], [2, 0, 0, 0], [2, 0, 0, 0]]);

        assert_eq!(
            simulate_move(base, Direction::Left).board.rows()[0],
            [4, 4, 0, 0]
        );
        assert_eq!(
            simulate_move(base, Direction::Right).board.rows()[0],
            [0, 0, 4, 4]
        );
        assert_eq!(simulate_move(base, Direction::Up).board.get(0, 0), 4);
        assert_eq!(simulate_move(base, Direction::Down).board.get(3, 0), 4);
    }

    #[test]
    fn row_lookup_merges_like_2048() {
        let row = pack_row([1, 1, 2, 2]);
        let result = left_row_move(row);

        assert_eq!(
            [
                rank_to_tile_value(row_rank(result.row, 0)),
                rank_to_tile_value(row_rank(result.row, 1)),
                rank_to_tile_value(row_rank(result.row, 2)),
                rank_to_tile_value(row_rank(result.row, 3)),
            ],
            [4, 8, 0, 0]
        );
        assert_eq!(result.score, 12);
    }

    #[test]
    fn rejects_values_that_do_not_fit_the_bitboard() {
        let mut values = [0; CELLS];
        values[0] = 3;
        assert!(Board::from_values(&values).is_err());

        values[0] = 1 << (MAX_TILE_EXPONENT + 1);
        assert!(Board::from_values(&values).is_err());
    }

    #[test]
    fn detects_game_over_boards() {
        let blocked = board([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]);
        let mergeable = board([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 2, 2]]);

        assert!(is_game_over(&blocked));
        assert!(!is_game_over(&mergeable));
    }

    #[test]
    fn rewards_stable_corner_positions() {
        let stable = board([
            [1024, 512, 256, 128],
            [64, 32, 16, 8],
            [4, 2, 0, 0],
            [0, 0, 0, 0],
        ]);
        let unstable = board([
            [0, 512, 256, 128],
            [64, 32, 16, 8],
            [4, 2, 1024, 0],
            [0, 0, 0, 0],
        ]);

        let options = EvaluationOptions {
            preferred_corner: Some(Corner::TopLeft),
            risk_weight: Some(1.2),
            preset: Some(HeuristicPresetName::Balanced),
        };

        assert_eq!(choose_preferred_corner(&stable), Corner::TopLeft);
        assert!(evaluate(&stable, &options) > evaluate(&unstable, &options));
    }

    #[test]
    fn finds_best_move_for_simple_board() {
        let simple = board([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
        let decision = find_best_move_core(
            simple,
            &FindBestMoveOptions {
                thinking_strength: Some(3.0),
                use_dynamic_depth: Some(false),
                max_depth: Some(1),
                time_budget_ms: Some(f64::INFINITY),
                heuristic_preset: Some(HeuristicPresetName::Balanced),
            },
        )
        .expect("expected a decision");

        assert_eq!(decision.best_direction.as_deref(), Some("left"));
        assert!(decision.metrics.nodes > 0);
    }

    #[test]
    fn cpu_decision_config_uses_expectimax_backend() {
        let simple = board([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
        let options = FindBestMoveOptions {
            thinking_strength: Some(3.0),
            use_dynamic_depth: Some(false),
            max_depth: Some(1),
            time_budget_ms: Some(f64::INFINITY),
            heuristic_preset: Some(HeuristicPresetName::Balanced),
        };

        let core = find_best_move_core(simple, &options).expect("expected a core decision");
        let configured =
            find_best_move_with_decision_config(simple, &options, &DecisionConfig::default())
                .expect("cpu backend should not fail")
                .expect("expected a configured decision");

        assert_eq!(configured.best_direction, core.best_direction);
        assert_eq!(configured.depth, core.depth);
    }

    #[test]
    fn derives_cuda_rollouts_from_strength() {
        let low = FindBestMoveOptions {
            thinking_strength: Some(1.0),
            ..FindBestMoveOptions::default()
        };
        let high = FindBestMoveOptions {
            thinking_strength: Some(10.0),
            ..FindBestMoveOptions::default()
        };

        assert_eq!(DecisionConfig::default().resolved_rollouts(&low), 512);
        assert_eq!(DecisionConfig::default().resolved_rollouts(&high), 65536);

        let explicit = DecisionConfig {
            rollouts: Some(1234),
            ..DecisionConfig::default()
        };
        assert_eq!(explicit.resolved_rollouts(&high), 1234);
    }

    #[test]
    fn runs_deterministic_benchmark_games() {
        let strategy = BenchmarkStrategyConfig {
            name: "test-balanced".to_string(),
            thinking_strength: Some(1.0),
            use_dynamic_depth: Some(false),
            max_depth: Some(1),
            time_budget_ms: Some(f64::INFINITY),
            heuristic_preset: Some(HeuristicPresetName::Balanced),
        };

        let first = run_benchmark_game(Seed::Number(3370.0), &strategy, 12);
        let second = run_benchmark_game(Seed::Number(3370.0), &strategy, 12);

        assert_eq!(second, first);
        assert!(first.steps > 0);
    }
}
