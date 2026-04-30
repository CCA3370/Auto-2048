use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=src/cuda/rollout.cu");
    println!("cargo:rerun-if-env-changed=CUDA_ARCH");
    println!("cargo:rerun-if-env-changed=CUDA_PATH");
    println!("cargo:rerun-if-env-changed=NVCC");

    if env::var_os("CARGO_FEATURE_CUDA").is_none() {
        return;
    }

    let target = env::var("TARGET").unwrap_or_default();
    if target.contains("wasm32") {
        panic!("the cuda feature is native-only and cannot be used for wasm32 builds");
    }

    let nvcc = find_nvcc().unwrap_or_else(|| {
        panic!(
            "CUDA feature enabled but nvcc was not found. Install the CUDA Toolkit, add nvcc to PATH, or set NVCC."
        )
    });
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let source = PathBuf::from("src/cuda/rollout.cu");
    let output_name = if target.contains("windows") {
        "cuda_rollout.lib"
    } else {
        "libcuda_rollout.a"
    };
    let output = out_dir.join(output_name);

    let mut command = Command::new(&nvcc);
    command
        .arg("--lib")
        .arg("-std=c++17")
        .arg("-O3")
        .arg("-arch")
        .arg(env::var("CUDA_ARCH").unwrap_or_else(|_| "sm_60".to_string()))
        .arg("-o")
        .arg(&output)
        .arg(&source);

    let status = command
        .status()
        .unwrap_or_else(|err| panic!("failed to run nvcc at {}: {err}", nvcc.display()));
    if !status.success() {
        panic!("nvcc failed while compiling {}", source.display());
    }

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=cuda_rollout");

    if let Some(cuda_lib_dir) = cuda_lib_dir(&nvcc, target.contains("windows")) {
        println!("cargo:rustc-link-search=native={}", cuda_lib_dir.display());
    }
    println!("cargo:rustc-link-lib=dylib=cudart");
}

fn find_nvcc() -> Option<PathBuf> {
    if let Some(path) = env::var_os("NVCC").map(PathBuf::from) {
        return Some(path);
    }

    if let Some(cuda_path) = env::var_os("CUDA_PATH").map(PathBuf::from) {
        let candidate = cuda_path
            .join("bin")
            .join(if cfg!(windows) { "nvcc.exe" } else { "nvcc" });
        if candidate.exists() {
            return Some(candidate);
        }
    }

    Command::new("nvcc")
        .arg("--version")
        .status()
        .ok()
        .filter(|status| status.success())
        .map(|_| PathBuf::from("nvcc"))
}

fn cuda_lib_dir(nvcc: &Path, is_windows: bool) -> Option<PathBuf> {
    let cuda_root = env::var_os("CUDA_PATH").map(PathBuf::from).or_else(|| {
        nvcc.parent()
            .and_then(|bin| bin.parent())
            .map(Path::to_path_buf)
    });

    cuda_root
        .into_iter()
        .flat_map(|root| {
            if is_windows {
                vec![root.join("lib").join("x64")]
            } else {
                vec![root.join("lib64"), root.join("lib")]
            }
        })
        .find(|candidate| candidate.exists())
}
