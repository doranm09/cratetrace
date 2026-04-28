use std::env;
use std::path::PathBuf;

use cratetrace_core::{trace_history, CratetraceError, Result, TraceOptions};

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        None | Some("--help") | Some("help") => {
            print_usage();
            Ok(())
        }
        Some("trace") => {
            let options = parse_trace_args(args.collect())?;
            let report = trace_history(&options)?;
            println!(
                "generated {} commit graphs plus a roll-up under {}",
                report.commits.len(),
                report.artifact_root.display()
            );
            Ok(())
        }
        Some(command) => Err(CratetraceError::new(format!(
            "unknown command `{command}`"
        ))),
    }
}

fn parse_trace_args(args: Vec<String>) -> Result<TraceOptions> {
    let current_dir = env::current_dir()?;
    let mut repo_root = current_dir.clone();
    let mut revision_range = String::from("HEAD~9..HEAD");
    let mut output_dir = PathBuf::from(".cratetrace");
    let mut render_svg = true;

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--repo" => {
                index += 1;
                repo_root = PathBuf::from(required_value(&args, index, "--repo")?);
            }
            "--range" => {
                index += 1;
                revision_range = required_value(&args, index, "--range")?;
            }
            "--out" => {
                index += 1;
                output_dir = PathBuf::from(required_value(&args, index, "--out")?);
            }
            "--no-svg" => {
                render_svg = false;
            }
            flag => {
                return Err(CratetraceError::new(format!("unknown flag `{flag}`")));
            }
        }
        index += 1;
    }

    if repo_root.is_relative() {
        repo_root = current_dir.join(repo_root);
    }
    if output_dir.is_relative() {
        output_dir = repo_root.join(output_dir);
    }

    Ok(TraceOptions {
        repo_root,
        revision_range,
        output_dir,
        render_svg,
    })
}

fn required_value(args: &[String], index: usize, flag: &str) -> Result<String> {
    args.get(index)
        .cloned()
        .ok_or_else(|| CratetraceError::new(format!("missing value for `{flag}`")))
}

fn print_usage() {
    println!(
        "cratetrace-cli\n\nCommands:\n  trace   Generate whole-project commit UML-style DOT/SVG artifacts\n\nUsage:\n  cratetrace-cli trace [--repo PATH] [--range REV_RANGE] [--out PATH] [--no-svg]"
    );
}
