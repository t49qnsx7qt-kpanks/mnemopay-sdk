"""
Wrapper that runs longmemeval-repo/src/evaluation/evaluate_qa.py with Groq as
the judge LLM (llama-3.3-70b-versatile, free tier, 30 req/min).

Why: the upstream script hardcodes OpenAI + a localhost vLLM fallback. We don't
have an OpenAI key wired, so we patch the OpenAI client to point at Groq's
OpenAI-compatible endpoint and register llama-3.3-70b-versatile in the model zoo.

Usage:
  python run_eval_groq.py <hyp_file.jsonl> <ref_file.json>
"""
import os
import sys
import importlib.util

HYP = sys.argv[1] if len(sys.argv) > 1 else "results/reasoning_20260415/hypothesis.jsonl"
REF = sys.argv[2] if len(sys.argv) > 2 else "data/longmemeval_s_cleaned.json"

_groq_key = os.environ.get("GROQ_API_KEY") or os.environ.get("OPENAI_API_KEY")
if not _groq_key:
    raise RuntimeError(
        "Set GROQ_API_KEY (preferred) or OPENAI_API_KEY before running this evaluator."
    )
os.environ["OPENAI_API_KEY"] = _groq_key
os.environ["OPENAI_BASE_URL"] = "https://api.groq.com/openai/v1"

# Load the upstream evaluator without running it yet
spec = importlib.util.spec_from_file_location(
    "evaluate_qa",
    "longmemeval-repo/src/evaluation/evaluate_qa.py",
)

# Patch the OpenAI client so the eval hits Groq instead of localhost
import openai
_original_client = openai.OpenAI
def _patched_client(*args, **kwargs):
    kwargs["base_url"] = "https://api.groq.com/openai/v1"
    kwargs["api_key"] = os.environ["OPENAI_API_KEY"]
    return _original_client(*args, **kwargs)
openai.OpenAI = _patched_client

# Register our judge model in the module zoo by monkey-patching sys.argv
# upstream script reads sys.argv[1..3] as metric_model, hyp, ref
sys.argv = [
    "evaluate_qa.py",
    "llama-3.1-70b-instruct",  # maps to `local` path in upstream — we've repointed that to Groq
    HYP,
    REF,
]

# Now execute the upstream script. It will use the patched OpenAI client.
module = importlib.util.module_from_spec(spec)
# Patch model_zoo BEFORE execution by injecting the real Groq model name
import types
original_spec_exec = spec.loader.exec_module
def _patched_exec(mod):
    # Inject a hook that runs after the top-level model_zoo dict is created
    original_spec_exec(mod)
_patched_exec.__wrapped__ = original_spec_exec

# Actually simplest: exec the module text with a mutated model_zoo
with open("longmemeval-repo/src/evaluation/evaluate_qa.py") as f:
    src = f.read()
# Rewrite the 'local' entry for llama-3.1-70b-instruct to use the real Groq
# model id with the Groq OpenAI-compatible base URL (handled via client patch above)
src = src.replace(
    "'llama-3.1-70b-instruct': ('meta-llama/Meta-Llama-3.1-70B-Instruct', 'local'),",
    "'llama-3.1-70b-instruct': ('llama-3.3-70b-versatile', 'openai'),",
)
# Disable the verbose per-question print to keep output manageable for 500 items
src = src.replace("verbose = True", "verbose = False")
# Windows encoding fix — force utf-8 on file reads/writes
src = src.replace("open(hyp_file).readlines()", "open(hyp_file, encoding='utf-8').readlines()")
src = src.replace("json.load(open(hyp_file))", "json.load(open(hyp_file, encoding='utf-8'))")
src = src.replace("json.load(open(ref_file))", "json.load(open(ref_file, encoding='utf-8'))")
src = src.replace("open(ref_file).readlines()", "open(ref_file, encoding='utf-8').readlines()")
src = src.replace("open(result_file, 'w')", "open(result_file, 'w', encoding='utf-8')")
exec(compile(src, "evaluate_qa.py", "exec"), {"__name__": "__main__"})
