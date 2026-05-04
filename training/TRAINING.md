# Fusion Engine Training Pipeline

Policy/value neural network training for the Fusion beam search engine. The active path trains a shared state encoder with candidate-move policy heads and a scalar value head, then exports ONNX search/player heads for native runtime experiments and browser-side coaching.

Legacy teacher/student distillation code is still present for historical tests and reference only. It is not the current deployment path.

## Current Status

- Phase 1 training is complete; no additional training budget is currently planned.
- Best original checkpoint: `pvc-real-r03` (`val_total_loss=1186.6691`).
- Browser deployment currently uses the loss-rebalanced search head: `mosaic-fusion-testing/static/models/pvc-rebal-r01.onnx`.
- Training data: `training_data.bin` with 350,307 samples plus policy/value request, label, group, and player-context sidecars.
- Detailed checkpoint record: `POLICY_VALUE_STATE_2026-03-12.md`.

## Contract References

- `training/PHASE0_STATE_CONTRACT.md`
- `training/PHASE1_SEARCH_ALIGNED_SUPERVISION.md`
- `training/POLICY_VALUE_REBUILD_BLUEPRINT.md`
- `training/POLICY_VALUE_V2_CONTRACT_PLAN.md`
- `training/POLICY_VALUE_STATE_2026-03-12.md`

Phase 0 defines replay-aligned schema and artifact ownership. Phase 1 defines search-aligned policy/value supervision. Phase 2 owns ONNX runtime integration and browser/native feature-contract parity.

## Active Pipeline

```text
.ttrm replays
    -> preprocess_replays.py
    -> training_data.bin + metadata/groups sidecars
    -> generate_policy_value_labels.py
    -> *.policy_value.requests.jsonl + *.policy_value.jsonl + player-context sidecars
    -> train_policy_value.py on Modal
    -> export_policy_value_onnx.py
    -> search-head/player-head ONNX artifacts
    -> policy_value_runtime.rs or onnxruntime-web
```

Active entrypoints:

- local artifact prep: `training/scripts/preprocess_replays.py`
- local label generation: `training/scripts/generate_policy_value_labels.py`
- local training entrypoint: `training/scripts/train_policy_value.py`
- local export entrypoint: `training/scripts/export_policy_value_onnx.py`
- remote launcher: `training/scripts/modal_app.py::launch_policy_value_pipeline`

Required artifact set for `training/training_data.bin`:

- `training_data.bin`
- `training_data.bin.metadata.json`
- `training_data.bin.groups.u64`
- `training_data.bin.policy_value.requests.jsonl`
- `training_data.bin.policy_value.jsonl`
- `training_data.bin.policy_value.metadata.json`
- `training_data.bin.policy_value.player_context.jsonl`
- `training_data.bin.policy_value.player_context.metadata.json`

Typical path from `fusion-engine/`:

```bash
python3 training/scripts/preprocess_replays.py data/replays training/training_data.bin --workers 10
python3 training/scripts/generate_policy_value_labels.py training/training_data.bin
modal run training/scripts/modal_app.py::launch_policy_value_pipeline --local-data-path training/training_data.bin
```

## Model Architecture

```text
PolicyValueNet (285K params)
├── Shared state encoder: 854 features -> hidden state
├── Shared move encoder: per-candidate move features -> hidden state
├── Search policy head: masked logits over candidate moves
├── Player context head: player-style logits with player_aux_context
└── Value head: scalar board-quality estimate
```

Search-head ONNX exports use three inputs: `features`, `candidate_move_features`, and `candidate_mask`. Player-head ONNX exports additionally require `player_aux_context` with 56 dimensions and are not wired into browser inference yet.

## Feature Vector

The shared state feature vector is 854 floats:

| Offset | Size | Description |
|--------|------|-------------|
| 0-399 | 400 | Player board, 10 columns x 40 rows, column-major binary occupancy |
| 400-799 | 400 | Opponent board, same layout |
| 800-848 | 49 | Piece one-hot slots: current, hold, next 5 |
| 849 | 1 | `combo / 20`, clamped to 1 |
| 850 | 1 | `b2b / 10`, clamped to 1 |
| 851 | 1 | `lines_total / 100`, clamped to 1 |
| 852 | 1 | `pending_garbage / 12`, clamped to 1 |
| 853 | 1 | `bag_number / 20`, clamped to 1 |

Candidate move features are `64 x 14` floats with a parallel 64-entry candidate mask.

## Directory Structure

```text
training/
├── TRAINING.md
├── POLICY_VALUE_STATE_2026-03-12.md
├── training_data.bin
├── training_data.bin.*
├── pyproject.toml
├── uv.lock
├── data/
│   ├── dataset.py
│   └── policy_value_dataset.py
├── models/
│   ├── policy_value.py
│   ├── policy_value_lit_module.py
│   ├── teacher.py        # legacy
│   └── student.py        # legacy
├── scripts/
│   ├── preprocess_replays.py
│   ├── generate_policy_value_labels.py
│   ├── policy_value_pipeline.py
│   ├── train_policy_value.py
│   ├── export_policy_value_onnx.py
│   ├── modal_app.py
│   ├── export_weights.py      # legacy
│   └── distill_student.py     # legacy
├── utils/
│   ├── config.py
│   ├── example_schema.py
│   └── policy_value_schema.py
└── tests/
```

## Modal Deployment

Training runs on Modal with `modal.Volume` for data and checkpoints.

Default A10 policy/value launcher settings:

- batch size: `1024`
- dataloader workers: `4`
- max epochs: `50`
- learning rate: `3e-4`
- weight decay: `1e-5`
- precision: inherited from the active Modal profile, typically `bf16-mixed`

Volume paths:

- Data: `fusion-training-data:/`
- Checkpoints: `fusion-training-checkpoints:/policy_value/{profile_name}/`

Operational lessons:

- Reducers must call `data_vol.reload()` before reading worker outputs.
- Upload paths must be idempotent and tolerate pre-existing files.
- Request-shard temp files must outlive `batch_upload()`.
- Prefer reducer-only resume over full reruns after shard fan-out.
- `modal app list` plus volume inspection is more reliable than a silent PTY for status.

## Artifact Readiness

Readiness is stricter than file presence:

- Base dataset byte size must equal `sample_count * BYTES_PER_SAMPLE`.
- Metadata files must agree on a positive `sample_count`.
- Request, label, and player-context JSONL line counts must match.
- Line-by-line identities must align on `(replay_id, round_id, player_id, frame_id)`.
- Train/validation split is by replay-round group ID, not row index.

Move IDs use the Rust `Move.raw` piece order from `src/header.rs`: `I=0, O=1, T=2, L=3, J=4, S=5, Z=6`. Python policy/value code must use `PIECE_ORDER = "iotljsz"`.

## Tests

Run from `fusion-engine/training/`:

```bash
python3 -m pytest tests/ -v --tb=short
```

Key coverage:

| Test | Covers |
|------|--------|
| `test_dataset_contract.py` | Binary dataset and schema contract |
| `test_preprocess_contract.py` | Preprocessing and sidecar alignment |
| `test_generate_policy_value_labels.py` | Label generation and sharding |
| `test_policy_value_dataset.py` | Dataset loading, collate, player-context features |
| `test_policy_value_model.py` | Network shapes and forward contracts |
| `test_policy_value_lit_module.py` | Losses, metrics, and training steps |
| `test_policy_value_pipeline.py` | Artifact readiness and identity alignment |
| `test_export_policy_value_onnx.py` | ONNX export contract |
| `test_runtime_training_contract_parity.py` | Runtime/training feature parity |
| `test_modal_app_bootstrap.py` | Modal import resilience |
| `test_teacher_target_contract.py` | Legacy teacher-output contract |

## Legacy Teacher/Student Path

Legacy teacher/student files remain because older tests and artifacts reference them, but they are not the active deployment path:

- `models/teacher.py`
- `models/student.py`
- `scripts/distill_student.py`
- `scripts/export_weights.py`
- flat `student_weights.bin` export notes in older docs and memories

Do not use the legacy path for new neural-coaching work unless explicitly reviving that experiment.

## Known Issues

- Local scripts may require `PYTHONPATH` set to the `fusion-engine/` repo root for module resolution.
- Large artifacts such as `training_data.bin` and replay manifests are intentionally not committed.
- Browser deployment currently uses the search head only; player-head inference still needs `player_aux_context` wiring.
