"""Replay one question against the Groq judge and print the RAW unparsed response."""
import os, json, sys
sys.path.insert(0, "longmemeval-repo/src/evaluation")
from evaluate_qa import get_anscheck_prompt
from openai import OpenAI

_groq_key = os.environ.get("GROQ_API_KEY") or os.environ.get("OPENAI_API_KEY")
if not _groq_key:
    raise RuntimeError("Set GROQ_API_KEY before running this probe.")

client = OpenAI(
    api_key=_groq_key,
    base_url="https://api.groq.com/openai/v1",
)

refs = json.load(open("data/longmemeval_s_cleaned.json", encoding="utf-8"))
qid2q = {e["question_id"]: e for e in refs}

hyps = [json.loads(l) for l in open("results/reasoning_20260415/hypothesis.jsonl", encoding="utf-8").readlines()]

for i, h in enumerate(hyps[:3]):
    ref = qid2q[h["question_id"]]
    prompt = get_anscheck_prompt(ref["question_type"], ref["question"], ref["answer"], h["hypothesis"],
                                 abstention="_abs" in h["question_id"])
    resp = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        n=1, temperature=0, max_tokens=10,
    )
    raw = resp.choices[0].message.content
    print(f"--- Q{i+1}: {h['question_id']} ({ref['question_type']}) ---")
    print(f"Question: {ref['question']}")
    print(f"Gold:     {ref['answer']}")
    print(f"Hyp:      {h['hypothesis'][:150]}...")
    print(f"RAW judge output: {raw!r}")
    print(f"Parsed label:     {'yes' in raw.lower()}")
    print()
