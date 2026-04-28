"""Partial metrics reader — no assert on model name so we can peek mid-run."""
import sys, json
import numpy as np

in_file, ref_file = sys.argv[1], sys.argv[2]
in_data = [json.loads(line) for line in open(in_file, encoding="utf-8").readlines()]
ref_data = json.load(open(ref_file, encoding="utf-8"))
ref_data = {x["question_id"]: x for x in ref_data}

all_acc, task_acc = [], []
qtypes = ["single-session-user", "single-session-preference", "single-session-assistant",
          "multi-session", "temporal-reasoning", "knowledge-update"]
type2acc = {t: [] for t in qtypes}
abstention_acc = []

for entry in in_data:
    qid = entry["question_id"]
    if qid not in ref_data:
        continue
    qtype = ref_data[qid]["question_type"]
    lbl = 1 if entry["autoeval_label"]["label"] else 0
    type2acc[qtype].append(lbl)
    if "_abs" in qid:
        abstention_acc.append(lbl)

print(f"\nJudged so far: {len(in_data)} entries")
print("Evaluation results by task:")
for k, v in type2acc.items():
    if v:
        print(f"  {k}: {round(np.mean(v), 4)} ({len(v)})")
        all_acc += v
        task_acc.append(np.mean(v))

if task_acc:
    print(f"\nTask-averaged Accuracy: {round(np.mean(task_acc), 4)}")
    print(f"Overall Accuracy:       {round(np.mean(all_acc), 4)}")
if abstention_acc:
    print(f"Abstention Accuracy:    {round(np.mean(abstention_acc), 4)} ({len(abstention_acc)})")
