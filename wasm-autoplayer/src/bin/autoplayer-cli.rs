use serde::Serialize;
use std::env;
use std::process;
use wasm_autoplayer::{
    find_best_move_for_values_with_decision_config, play_game_for_config_with_decision_config,
    run_benchmark_for_configs_with_decision_config,
    run_benchmark_for_configs_with_progress_and_decision_config, BenchmarkProgress,
    BenchmarkStrategyConfig, DecisionBackend, DecisionConfig, FindBestMoveOptions,
    HeuristicPresetName, Seed,
};

#[derive(Clone, Default)]
struct SearchArgs {
    thinking_strength: Option<f64>,
    use_dynamic_depth: Option<bool>,
    max_depth: Option<u32>,
    time_budget_ms: Option<f64>,
    heuristic_preset: Option<HeuristicPresetName>,
}

impl SearchArgs {
    fn to_options(&self) -> FindBestMoveOptions {
        FindBestMoveOptions {
            thinking_strength: self.thinking_strength,
            use_dynamic_depth: self.use_dynamic_depth,
            max_depth: self.max_depth,
            time_budget_ms: self.time_budget_ms,
            heuristic_preset: self.heuristic_preset,
        }
    }

    fn to_strategy(&self, name: String) -> BenchmarkStrategyConfig {
        BenchmarkStrategyConfig {
            name,
            thinking_strength: self.thinking_strength,
            use_dynamic_depth: self.use_dynamic_depth,
            max_depth: self.max_depth,
            time_budget_ms: self.time_budget_ms,
            heuristic_preset: self.heuristic_preset,
        }
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let Some(command) = args.next() else {
        print_usage();
        return Ok(());
    };
    let args: Vec<String> = args.collect();

    match command.as_str() {
        "decide" => command_decide(&args),
        "play" => command_play(&args),
        "bench" => command_bench(&args),
        "-h" | "--help" | "help" => {
            print_usage();
            Ok(())
        }
        _ => Err(format!("unknown command: {command}")),
    }
}

fn command_decide(args: &[String]) -> Result<(), String> {
    let mut board = None;
    let mut search = SearchArgs::default();
    let mut decision_config = DecisionConfig::default();
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--board" => board = Some(parse_board(take_value(args, &mut index, "--board")?)?),
            flag if parse_search_flag(flag, args, &mut index, &mut search)? => {}
            flag if parse_backend_flag(flag, args, &mut index, &mut decision_config)? => {}
            "--help" | "-h" => {
                print_usage();
                return Ok(());
            }
            flag => return Err(format!("unknown decide option: {flag}")),
        }
        index += 1;
    }

    let board = board.ok_or_else(|| "decide requires --board".to_string())?;
    let options = search.to_options();
    print_backend_info(&decision_config, &[("decide", options.clone())]);
    let decision =
        find_best_move_for_values_with_decision_config(&board, options, &decision_config)?;
    write_json(&decision)
}

fn command_play(args: &[String]) -> Result<(), String> {
    let mut seed = Seed::Number(0.0);
    let mut max_moves = 2000;
    let mut search = SearchArgs::default();
    let mut decision_config = DecisionConfig::default();
    let mut name = "cli-play".to_string();
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--seed" => seed = parse_seed(take_value(args, &mut index, "--seed")?),
            "--max-moves" => {
                max_moves = parse_u32(take_value(args, &mut index, "--max-moves")?, "--max-moves")?
            }
            "--name" => name = take_value(args, &mut index, "--name")?.to_string(),
            flag if parse_search_flag(flag, args, &mut index, &mut search)? => {}
            flag if parse_backend_flag(flag, args, &mut index, &mut decision_config)? => {}
            "--help" | "-h" => {
                print_usage();
                return Ok(());
            }
            flag => return Err(format!("unknown play option: {flag}")),
        }
        index += 1;
    }

    let strategy = search.to_strategy(name);
    print_backend_info(
        &decision_config,
        &[(strategy.name.as_str(), FindBestMoveOptions::from(&strategy))],
    );
    let result =
        play_game_for_config_with_decision_config(seed, &strategy, max_moves, &decision_config)?;
    write_json(&result)
}

fn command_bench(args: &[String]) -> Result<(), String> {
    let mut seeds = vec![Seed::Number(0.0)];
    let mut max_moves = None;
    let mut progress = false;
    let mut search = SearchArgs::default();
    let mut decision_config = DecisionConfig::default();
    let mut strategy_specs = Vec::new();
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--seeds" => seeds = parse_seeds(take_value(args, &mut index, "--seeds")?),
            "--max-moves" => {
                max_moves = Some(parse_u32(
                    take_value(args, &mut index, "--max-moves")?,
                    "--max-moves",
                )?)
            }
            "--strategy" => {
                strategy_specs.push(take_value(args, &mut index, "--strategy")?.to_string())
            }
            "--progress" => progress = true,
            flag if parse_search_flag(flag, args, &mut index, &mut search)? => {}
            flag if parse_backend_flag(flag, args, &mut index, &mut decision_config)? => {}
            "--help" | "-h" => {
                print_usage();
                return Ok(());
            }
            flag => return Err(format!("unknown bench option: {flag}")),
        }
        index += 1;
    }

    let strategies = if strategy_specs.is_empty() {
        vec![search.to_strategy("cli-bench".to_string())]
    } else {
        strategy_specs
            .iter()
            .map(|spec| parse_strategy(spec, &search))
            .collect::<Result<Vec<_>, _>>()?
    };

    let backend_items: Vec<(&str, FindBestMoveOptions)> = strategies
        .iter()
        .map(|strategy| (strategy.name.as_str(), FindBestMoveOptions::from(strategy)))
        .collect();
    print_backend_info(&decision_config, &backend_items);

    let summary = if progress {
        run_benchmark_for_configs_with_progress_and_decision_config(
            &seeds,
            &strategies,
            max_moves,
            &decision_config,
            |progress| {
                print_benchmark_progress(progress);
            },
        )?
    } else {
        run_benchmark_for_configs_with_decision_config(
            &seeds,
            &strategies,
            max_moves,
            &decision_config,
        )?
    };
    write_json(&summary)
}

fn parse_search_flag(
    flag: &str,
    args: &[String],
    index: &mut usize,
    search: &mut SearchArgs,
) -> Result<bool, String> {
    match flag {
        "--strength" => {
            search.thinking_strength = Some(parse_f64(
                take_value(args, index, "--strength")?,
                "--strength",
            )?);
            Ok(true)
        }
        "--depth" => {
            search.max_depth = Some(parse_u32(take_value(args, index, "--depth")?, "--depth")?);
            search.use_dynamic_depth = Some(false);
            Ok(true)
        }
        "--dynamic-depth" => {
            search.use_dynamic_depth = Some(true);
            Ok(true)
        }
        "--no-dynamic-depth" => {
            search.use_dynamic_depth = Some(false);
            Ok(true)
        }
        "--time-ms" => {
            search.time_budget_ms = Some(parse_time_budget(take_value(args, index, "--time-ms")?)?);
            Ok(true)
        }
        "--preset" => {
            search.heuristic_preset = Some(parse_preset(take_value(args, index, "--preset")?)?);
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn parse_backend_flag(
    flag: &str,
    args: &[String],
    index: &mut usize,
    decision_config: &mut DecisionConfig,
) -> Result<bool, String> {
    match flag {
        "--backend" => {
            decision_config.backend = parse_backend(take_value(args, index, "--backend")?)?;
            Ok(true)
        }
        "--gpu" => {
            decision_config.gpu_index = parse_u32(take_value(args, index, "--gpu")?, "--gpu")?;
            Ok(true)
        }
        "--rollouts" => {
            decision_config.rollouts = Some(parse_positive_u32(
                take_value(args, index, "--rollouts")?,
                "--rollouts",
            )?);
            Ok(true)
        }
        "--rollout-steps" => {
            decision_config.rollout_steps = parse_positive_u32(
                take_value(args, index, "--rollout-steps")?,
                "--rollout-steps",
            )?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn parse_strategy(spec: &str, defaults: &SearchArgs) -> Result<BenchmarkStrategyConfig, String> {
    let parts: Vec<&str> = spec.split(':').collect();
    if parts.is_empty() || parts[0].trim().is_empty() {
        return Err("strategy must start with a name".to_string());
    }

    let mut search = defaults.clone();
    if let Some(value) = parts.get(1).filter(|value| !value.trim().is_empty()) {
        search.thinking_strength = Some(parse_f64(value, "strategy strength")?);
    }
    if let Some(value) = parts.get(2).filter(|value| !value.trim().is_empty()) {
        search.heuristic_preset = Some(parse_preset(value)?);
    }
    if let Some(value) = parts.get(3).filter(|value| !value.trim().is_empty()) {
        search.max_depth = Some(parse_u32(value, "strategy depth")?);
        search.use_dynamic_depth = Some(false);
    }
    if parts.len() > 4 {
        return Err(format!("invalid strategy spec: {spec}"));
    }

    Ok(search.to_strategy(parts[0].to_string()))
}

fn parse_backend(input: &str) -> Result<DecisionBackend, String> {
    match input {
        "cpu" => Ok(DecisionBackend::Cpu),
        "cuda-rollout" | "cuda" => Ok(DecisionBackend::CudaRollout),
        _ => Err(format!("invalid backend: {input}")),
    }
}

fn parse_board(input: &str) -> Result<Vec<u32>, String> {
    let values: Result<Vec<u32>, String> = input
        .split(|ch: char| ch == ',' || ch == ';' || ch.is_whitespace())
        .filter(|part| !part.is_empty())
        .map(|part| parse_u32(part, "board value"))
        .collect();
    let values = values?;

    if values.len() != 16 {
        return Err(format!("board requires 16 values, got {}", values.len()));
    }
    Ok(values)
}

fn parse_seeds(input: &str) -> Vec<Seed> {
    input
        .split(',')
        .filter(|part| !part.trim().is_empty())
        .map(|part| parse_seed(part.trim()))
        .collect()
}

fn parse_seed(input: &str) -> Seed {
    input
        .parse::<f64>()
        .map(Seed::Number)
        .unwrap_or_else(|_| Seed::String(input.to_string()))
}

fn parse_preset(input: &str) -> Result<HeuristicPresetName, String> {
    match input {
        "balanced" => Ok(HeuristicPresetName::Balanced),
        "high-score" | "highscore" => Ok(HeuristicPresetName::HighScore),
        "survival" => Ok(HeuristicPresetName::Survival),
        _ => Err(format!("invalid preset: {input}")),
    }
}

fn parse_time_budget(input: &str) -> Result<f64, String> {
    match input {
        "inf" | "infinite" | "none" => Ok(f64::INFINITY),
        _ => parse_f64(input, "--time-ms"),
    }
}

fn parse_u32(input: &str, label: &str) -> Result<u32, String> {
    input
        .parse::<u32>()
        .map_err(|_| format!("{label} must be a non-negative integer, got {input}"))
}

fn parse_positive_u32(input: &str, label: &str) -> Result<u32, String> {
    let value = parse_u32(input, label)?;
    if value == 0 {
        Err(format!("{label} must be greater than zero"))
    } else {
        Ok(value)
    }
}

fn parse_f64(input: &str, label: &str) -> Result<f64, String> {
    input
        .parse::<f64>()
        .map_err(|_| format!("{label} must be a number, got {input}"))
}

fn take_value<'a>(args: &'a [String], index: &mut usize, flag: &str) -> Result<&'a str, String> {
    *index += 1;
    args.get(*index)
        .map(|value| value.as_str())
        .ok_or_else(|| format!("{flag} requires a value"))
}

fn write_json<T: Serialize>(value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|err| err.to_string())?;
    println!("{json}");
    Ok(())
}

fn print_backend_info(decision_config: &DecisionConfig, items: &[(&str, FindBestMoveOptions)]) {
    if decision_config.backend != DecisionBackend::CudaRollout {
        return;
    }

    eprintln!(
        "backend=cuda-rollout gpu={} rolloutSteps={}",
        decision_config.gpu_index,
        decision_config.rollout_steps.max(1),
    );
    for (name, options) in items {
        eprintln!(
            "cuda-rollout strategy={} rollouts={}",
            name,
            decision_config.resolved_rollouts(options),
        );
    }
}

fn print_benchmark_progress(progress: &BenchmarkProgress) {
    eprintln!(
        "progress strategy={}/{}:{} game={}/{} seed={} step={} score={} maxTile={}",
        progress.strategy_index + 1,
        progress.strategy_count,
        progress.strategy_name,
        progress.game_index + 1,
        progress.game_count,
        format_seed(&progress.seed),
        progress.step,
        progress.score,
        progress.max_tile,
    );
}

fn format_seed(seed: &Seed) -> String {
    match seed {
        Seed::Number(value) if value.fract() == 0.0 => format!("{value:.0}"),
        Seed::Number(value) => value.to_string(),
        Seed::String(value) => value.clone(),
    }
}

fn print_usage() {
    println!(
        "Usage:
  autoplayer-cli decide --board \"2,2,0,0,...\" [--strength 10] [--depth 8] [--preset balanced]
  autoplayer-cli play [--seed 3370] [--max-moves 2000] [--strength 10] [--depth 8]
  autoplayer-cli bench [--seeds 1,2,3] [--strategy strong:10:survival:8] [--progress]

Common options:
  --strength <1-10>
  --depth <1-10>              Sets a fixed depth and disables dynamic depth.
  --dynamic-depth
  --no-dynamic-depth
  --time-ms <ms|inf>
  --preset <balanced|high-score|survival>
  --backend <cpu|cuda-rollout>
  --gpu <index>
  --rollouts <n>              CUDA rollout batch size per legal root move.
  --rollout-steps <n>         CUDA simulation step cap per rollout.

Bench options:
  --progress                 Prints live scores to stderr while final JSON stays on stdout."
    );
}
