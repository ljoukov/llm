# RLM Research Report (Omar Khattab)  
Prepared: 2026-02-16

## 1) Scope
This report answers:
- Which paper introduces RLM (Recursive Language Models) associated with Omar Khattab.
- What follow-up work exists (paper/blog/code-level development).
- What experiments/results were reported.
- What open-source implementations exist (including DSPy and GitHub repos).

## 2) Primary Sources Used
1. Omar Khattab X post (the link provided by user), mirrored via fxtwitter API:  
   https://x.com/lateinteraction/status/2022725370152190215  
2. RLM paper (arXiv):  
   https://arxiv.org/abs/2512.24601
3. Baleen paper (arXiv):  
   https://arxiv.org/abs/2101.00436
4. Official RLM codebase:  
   https://github.com/alexzhang13/rlm
5. RLM minimal implementation:  
   https://github.com/alexzhang13/rlm-minimal
6. DSPy repository + RLM docs/module:
   - https://github.com/stanfordnlp/dspy
   - https://dspy.ai/api/modules/RLM/
7. Baleen code repository + ColBERT integration:
   - https://github.com/stanford-futuredata/Baleen
   - https://github.com/stanford-futuredata/ColBERT/tree/main/baleen
8. RLM-Qwen3-8B model release:
   https://huggingface.co/mit-oasys/rlm-qwen3-8b-v0.1
9. Original RLM blog post (early release):
   https://alexzhang13.github.io/blog/2025/rlm/
10. OpenAI model optimization (fine-tuning methods matrix):
    https://developers.openai.com/api/docs/guides/model-optimization/
11. OpenAI reinforcement fine-tuning guide:
    https://developers.openai.com/api/docs/guides/reinforcement-fine-tuning/
12. OpenAI supervised fine-tuning guide:
    https://developers.openai.com/api/docs/guides/supervised-fine-tuning/
13. Google Vertex AI Gemini supervised tuning:
    https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini-supervised-tuning
14. Google Vertex AI Gemini preference tuning:
    https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini-preference-tuning
15. Google Vertex AI tuning API reference:
    https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/tuning
16. Google Vertex AI open model tuning:
    https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/open-model-tuning

## 3) Short Answer
- **Paper introducing RLM**: **Recursive Language Models** (Alex L. Zhang, Tim Kraska, Omar Khattab), arXiv:2512.24601.
- **Prior precursor referenced by Omar in the X post**: **Baleen: Robust Multi-Hop Reasoning at Scale via Condensed Retrieval** (Khattab et al., 2021), arXiv:2101.00436.
- **Open source implementation**: Yes, multiple:
  - Official RLM engine: `alexzhang13/rlm` (PyPI package `rlms`).
  - DSPy implementation: `dspy.RLM` exists in `stanfordnlp/dspy` and DSPy docs.
  - Baleen implementation remains available in `stanford-futuredata/Baleen` / ColBERT.

## 4) Timeline and Attribution
- **2021-01-02**: Baleen preprint appears (multi-hop retrieval + condensed retrieval), later updated and published in NAACL findings context.  
  Source: https://arxiv.org/abs/2101.00436
- **2025-10-15**: Early RLM blog post publicly introduces the framing and initial experiments.  
  Source: https://alexzhang13.github.io/blog/2025/rlm/
- **2025-12-31**: RLM paper first posted on arXiv (v1).  
  Source: https://arxiv.org/abs/2512.24601
- **2026-01-28**: RLM paper updated (v2).  
  Source: https://arxiv.org/abs/2512.24601
- **2026-02-14**: Omar’s X post clarifies that RLMs are not just sub-agents or simple iterative retrieval; he explicitly references Baleen as earlier multi-hop/compaction work and distinguishes it from RLM recursion.  
  Source: https://x.com/lateinteraction/status/2022725370152190215

## 5) What Omar’s X Post Clarifies
From the linked post:
- RLM is framed as recursive symbolic interaction with the model’s own horizon/context, not merely tool-calling or “sub-agent” orchestration.
- Omar distinguishes this from his earlier 2020/2021-style multi-hop retrieval/compaction systems (Baleen).
- The post explicitly points to **“Robust Multi-Hop Reasoning at Scale via Condensed Retrieval”** as prior related work, but not as the RLM paper.

Interpretation: Baleen is a conceptual/technical antecedent on iterative context handling and compaction; the **explicit RLM formulation** is in the 2025/2026 RLM work.

## 6) RLM Paper: Experimental Design and Results
Paper: https://arxiv.org/abs/2512.24601

### 6.1 Benchmarks and Tasks
The paper evaluates four long-context tasks with different complexity profiles:
- **CodeQA** (LongBench-v2 split): repository-level code understanding.
- **BrowseComp+ (1K docs)**: multi-document long-context QA.
- **OOLONG**: long-context semantic transform + aggregation.
- **OOLONG-Pairs**: quadratic-style pair aggregation variant.

Reported task lengths (Table 1):
- CodeQA: **23K–4.2M tokens**
- BrowseComp+ (1K): **6M–11M tokens**
- OOLONG: **131K tokens**
- OOLONG-Pairs: **32K tokens**

### 6.2 Models and Baselines
For GPT-5 and Qwen3-Coder families, comparisons include:
- Base model (plain call)
- CodeAct (+ BM25)
- CodeAct (+ sub-calls)
- Summary/compaction agent
- RLM
- RLM (no sub-calls)

Also includes small model experiments with Qwen3-8B:
- Base
- RLM
- RLM (fine-tuned; called RLM-Qwen3-8B)

### 6.3 Main Quantitative Results (Table 1)
Key scores (higher is better; paper reports cost per query in USD):

#### GPT-5 family (RLM uses GPT-5 root with GPT-5-mini sub-calls)
- **CodeQA**: Base 24.0 vs **RLM 62.0**
- **BrowseComp+**: Base 0.0* vs **RLM 91.3**
- **OOLONG**: Base 44.0 vs **RLM 56.5**
- **OOLONG-Pairs**: Base 0.1 vs **RLM 58.0**

#### Qwen3-Coder-480B-A35B
- **CodeQA**: Base 20.0 vs RLM 56.0
- **BrowseComp+**: Base 0.0* vs RLM 44.7
- **OOLONG**: Base 36.0 vs RLM 48.0
- **OOLONG-Pairs**: Base 0.1 vs RLM 23.1

#### Qwen3-8B (small-scale post-training experiment)
- **Base**: 4.0 / 0.0 / 0.0 / 0.1
- **RLM**: 26.0 / 2.0 / 24.0 / 4.3
- **RLM (fine-tuned)**: **32.0 / 14.0 / 32.0 / 5.2**

Paper claim: fine-tuned RLM-Qwen3-8B improves over base Qwen3-8B by **28.3% average**.

### 6.4 Cost and Runtime Findings
- RLM median cost is often comparable to baseline model calls; tails can be expensive due to long trajectories.
- On BrowseComp+ (1K), the paper reports average cost around **$0.99** for RLM(GPT-5), while linear extrapolation of direct long-context ingestion is estimated higher.
- Authors report high variance in runtime/cost and note current implementation is sequential (no async sub-call scheduling), leaving optimization headroom.

### 6.5 Additional Scaling Notes from Appendix
- BrowseComp+ scaling experiment: RLM(GPT-5) remains strong as document count grows; paper text indicates perfect performance at 1000 docs in the reported subset, with no-subcall ablation near 90%.
- Qualitative trajectory analysis shows model-specific behaviors (e.g., Qwen variants sometimes making many redundant recursive calls).

### 6.6 Training Details for RLM-Qwen3-8B
- Distillation-like setup from Qwen3-Coder trajectories on LongBenchPro.
- 750 tasks -> 2250 candidate trajectories -> filtered to 1072 trajectories before turn-level filtering/cleanup.
- Reports cleaning template issues (`FINAL`/`FINAL_VAR` misuse) improved downstream behavior.
- Fine-tuning compute reported as roughly 48 H100-hours (small scale exploratory run).

## 7) Baleen (2021) Results Relevant to Omar’s Claim
Paper: https://arxiv.org/abs/2101.00436

Why relevant:
- Omar’s X post explicitly references Baleen as earlier multi-hop retrieval+compaction work, and distinguishes it from RLM.

Key experimental outcomes from Baleen:
- **HotPotQA retrieval saturation** (Table 2): Baleen reaches strong passage and answer recall at top-20 retrieval.
- **HoVer passage retrieval** (Table 3): Baleen substantially outperforms TF-IDF baseline and strong ablations; reported dev scores include:
  - Retrieval@100 (All): **92.2**
  - Passage EM (All): **63.6**
  - Passage F1 (All): **89.2**
- **HoVer sentence extraction + verification** (Table 4): Baleen 4-hop improves the overall HoVer score markedly versus baseline (paper reports 15.3 -> 57.5 in leaderboard context).
- **Ablations** (Table 5): FLIPR retrieval, condensing architecture, and latent hop ordering each contribute materially.

This supports Omar’s statement that he had prior multi-hop retrieval/condensation systems before formal RLM framing.

## 8) Open-Source Implementation Status

### 8.1 Official RLM Engine
Repo: https://github.com/alexzhang13/rlm
- Package: `rlms` (pyproject name), with REPL-based recursive execution.
- Supports multiple backends/environments (OpenAI/Anthropic/etc., local and sandboxed variants).
- README describes this as the official implementation tied to the paper.

### 8.2 DSPy Implementation (`dspy.RLM`)
Repo: https://github.com/stanfordnlp/dspy
Docs: https://dspy.ai/api/modules/RLM/

Verified in source:
- `dspy.predict.rlm.RLM` exists.
- API docs describe it as implementing the RLM paper approach.
- Includes recursive tools (`llm_query`, `llm_query_batched`), iterative REPL loop, typed outputs.
- Marked **experimental** in docs.
- Default interpreter uses Deno/Pyodide WASM sandbox; docs call out setup caveats.

Conclusion: there is now a **real DSPy RLM implementation**, not just conceptual alignment.

### 8.3 Baleen Implementation
- Paper points to: https://github.com/stanford-futuredata/Baleen
- Current Baleen repo README states implementation lives within ColBERT (submodule/new API lineage).
- ColBERT main tree still contains `baleen/` code paths.

### 8.4 Model Release
- HF model: https://huggingface.co/mit-oasys/rlm-qwen3-8b-v0.1
- Model card ties it to arXiv:2512.24601 and notes it expects RLM scaffold/environment.

### 8.5 Third-Party Implementations
- Example external repo exists (e.g., `ysz/recursive-llm`), but this should not be treated as canonical without deeper validation.

## 9) “Further Developed RLM” Assessment (as of 2026-02-16)
Evidence-based summary:
- Core formal introduction and strongest experiment set are in **arXiv:2512.24601**.
- Pre-paper development appeared in the **2025 blog** and then moved into official code.
- Practical development after paper is visible in OSS implementations (official RLM repo + DSPy module + model release).
- I did **not** find a separate second RLM paper by Omar beyond `2512.24601` in the checked sources.

## 10) Corrections/Notes Relative to the Grok Summary
Mostly correct, with one important nuance:
- Saying DSPy is the only “primary” implementation is incomplete now. There is also a dedicated official repo from paper authors: `alexzhang13/rlm`.
- Better framing: **two author-aligned implementations now exist**:
  1) standalone RLM engine (`alexzhang13/rlm`), and
  2) DSPy-native module (`dspy.RLM`).

## 11) Practical Takeaways
- If you want to reproduce paper-style behavior quickly: start with `alexzhang13/rlm`.
- If you are already building modular LM programs in DSPy: use `dspy.RLM`.
- If your use case is retrieval-heavy multi-hop evidence pipelines (not general recursive context reasoning), Baleen/ColBERT style pipelines are still relevant.

## 12) Can OpenAI/Google Fine-Tuning Simulate RLM? (as of 2026-02-16)

### 12.1 Key Distinction
RLM behavior is a combination of:
1) model policy, and
2) external recursive runtime (REPL + tool calls/subcalls + state handling).

Fine-tuning only updates model policy. So closed-model fine-tuning can make a model *behave like an RLM controller* inside a scaffold, but it does not by itself create native recursive execution.

### 12.2 OpenAI: Feasibility and Limits
From OpenAI docs:
- Fine-tuning methods matrix lists:
  - SFT and DPO on `gpt-4.1-2025-04-14`, `gpt-4.1-mini-2025-04-14`, `gpt-4.1-nano-2025-04-14`.
  - RFT on `o4-mini-2025-04-16`.
  - RFT marked as **reasoning models only**.
- RFT guide further states RFT is currently supported only on o-series and currently only `o4-mini`.
- SFT guide states tuned models can be trained for structured JSON outputs and function calls.

Practical implication:
- Yes, you can SFT/RFT a model to better output RLM-style plans, recursion decisions, and tool-call schemas.
- No, this does not remove the need for an external recursive runtime.

### 12.3 Google Vertex AI: Feasibility and Limits
From Google Vertex docs:
- Gemini supervised tuning supports:
  - `Gemini 2.5 Pro`
  - `Gemini 2.5 Flash`
  - `Gemini 2.5 Flash-Lite`
  - `Gemini 2.0 Flash`
  - `Gemini 2.0 Flash-Lite`
- Gemini preference tuning supports:
  - `Gemini 2.5 Flash`
  - `Gemini 2.5 Flash-Lite`
- Docs recommend low/off thinking budget for tuned tasks on thinking models.
- Tuning API and guides require JSONL datasets and expose adapter/hyperparameter controls (for example `adapter_size`, epochs, LR multiplier).

Practical implication:
- Yes, you can tune Gemini models to emulate an RLM controller policy.
- But recursive execution still requires external orchestration/tooling.

### 12.4 Open-Weight Route (Most Flexible for Full RLM Reproduction)
This is the path most aligned with the RLM paper:
- Authors already demonstrate post-training an open model (`RLM-Qwen3-8B`) with trajectory data.
- Reported training details include trajectory filtering/cleanup and roughly 48 H100-hours.

Recommended recipe:
1. Run a strong teacher model in RLM scaffold to collect trajectories.
2. Train SFT on high-quality trajectories to learn action format and control policy.
3. Optionally add preference/RL phase for trajectory quality, depth efficiency, and cost-awareness.
4. Evaluate on long-context tasks (CodeQA, BrowseComp+, OOLONG, OOLONG-Pairs) and cost/runtime metrics.

### 12.5 Direct Answer to Your Question
- **OpenAI RFT/SFT can help simulate RLM policy**, but only within platform constraints and with an external RLM scaffold.
- **Google SFT/preference tuning can also simulate controller behavior**, again requiring an external recursive runtime.
- **Open-weight fine-tuning is the best option** if your goal is maximal control and closest reproduction/extension of published RLM behavior.
