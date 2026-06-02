# Fusion

Fusion은 TETR.IO용 자동 플레이 실험과 코칭/분석 엔진을 한 저장소에 묶은 프로젝트입니다.
현재 코드 기준으로는 Discord 봇보다는, Rust로 작성된 테트리스 탐색 엔진을 Node.js/Playwright 자동화와 Python 학습 파이프라인에서 함께 쓰는 구조입니다.

## 전체 구조

```text
TETR.IO 브라우저
  -> Playwright 자동화(bot_play_auto_seed.js)
  -> WebSocket seed 캡처 + 7-bag 큐 재현(tetrio_queue.js)
  -> Node HTTP 래퍼(engine_server.js)
  -> Rust 탐색 바이너리(target/release/quick_best.exe)
  -> 추천 수 JSON
  -> 키 입력 수행
```

Rust 엔진은 보드, 미노, 홀드, 큐를 받아 가능한 배치를 생성하고 beam search로 최선 수를 고릅니다.
Node 쪽은 이 엔진을 실행 파일로 호출하거나 HTTP 서버로 감싸고, Playwright 스크립트는 실제 TETR.IO 화면에 키 입력을 보냅니다.

## 주요 실행 파일

| 파일 | 역할 |
| --- | --- |
| `engine_server.js` | `POST /best-move` 요청을 받아 `target/release/quick_best.exe`를 실행하고 결과 JSON을 반환합니다. 기본 포트는 `8787`입니다. |
| `bot_play_auto_seed.js` | TETR.IO를 Playwright로 열고 WebSocket 프레임에서 게임 seed/options를 자동 캡처한 뒤, 재현한 큐와 엔진 추천 수를 기반으로 키 입력을 수행합니다. |
| `bot_play_seed_test.js` | seed를 직접 넘겨 자동 입력을 시험하는 스크립트입니다. 실제 게임 seed와 일치해야 정상 동작합니다. |
| `bot_simulate_seed.js` | 브라우저 입력 없이 seed 기반으로 여러 턴의 추천 수와 내부 보드 갱신을 콘솔에서 시뮬레이션합니다. |
| `bot_decide_test.js` | 특정 seed/piece index에서 한 번만 엔진 추천 수를 확인합니다. |
| `tetrio_queue.js` | TETR.IO식 Park-Miller PRNG와 7-bag 큐 생성 로직을 구현합니다. |
| `tetrio_ws_logger.js` | TETR.IO WebSocket 프레임을 `ws-log.jsonl`로 기록하고 민감 토큰류는 일부 마스킹합니다. |
| `capture_tetrio_scripts.js`, `scan_tetrio_scripts.js`, `extract_*.js`, `inspect_*.js` | TETR.IO 스크립트/웹소켓 구조를 조사하기 위한 보조 도구입니다. |

## Rust 엔진

Rust crate 이름은 `direct-cobra-copy`입니다. 핵심 모듈은 다음과 같습니다.

| 경로 | 역할 |
| --- | --- |
| `src/bin/quick_best.rs` | CLI 엔트리포인트입니다. 현재 미노, 큐, 선택적 보드/홀드를 받아 추천 수를 JSON으로 출력합니다. |
| `src/board.rs` | 10x40 보드 표현, 라인 클리어, 배치 가능성, garbage 처리 등을 담당합니다. |
| `src/header.rs` | `Piece`, `Rotation`, `SpinType`, `Move` 등 핵심 타입과 비트 인코딩을 정의합니다. |
| `src/movegen.rs`, `src/pathfinder.rs` | 가능한 락 배치와 입력 경로 생성을 담당합니다. |
| `src/search.rs`, `src/search_config.rs`, `src/search_expand.rs` | hold를 포함한 beam search, futility pruning, quiescence extension, root score 수집을 구현합니다. |
| `src/eval.rs` | 구멍, 높이, bumpiness, row transition, well, TSD overhang, 4-wide well 등을 기반으로 보드 형태 점수를 계산합니다. |
| `src/attack.rs` | TETR.IO Season 2 기준 공격량, B2B, combo, perfect clear, surge release 등을 계산합니다. |
| `src/state.rs` | 현재 미노, hold, queue, B2B/combo, garbage, 코칭 상태 전이를 관리합니다. |
| `src/analysis.rs` | 실제 수와 엔진 최선 수를 비교해 severity, eval meter, insight tag를 계산합니다. |
| `src/policy_value_runtime.rs` | ONNX policy/value 모델 입력 feature 인코딩과 native `tract-onnx` 런타임을 담당합니다. |
| `src/wasm.rs`, `src/wasm_board.rs`, `src/wasm_types.rs` | 브라우저/프론트엔드에서 쓰기 위한 wasm-bindgen API입니다. |

기본 탐색 설정은 `SearchConfig::default()`에 있습니다. 주요 값은 beam width `800`, depth `14`, 7-bag 큐 확장 활성화, Tetra League 공격 설정, quiescence extension `3`입니다.
`quick_best` CLI에서는 응답성을 위해 `time_budget_ms: Some(50)`로 실행합니다.

## 설치와 빌드

Node 의존성:

```powershell
npm install
```

Rust 엔진 빌드:

```powershell
cargo build --release --bin quick_best
```

빌드가 끝나면 `engine_server.js`가 기대하는 실행 파일이 아래 경로에 생깁니다.

```text
target/release/quick_best.exe
```

## 추천 수 API 실행

먼저 엔진 서버를 켭니다.

```powershell
node .\engine_server.js
```

요청 형식:

```json
{
  "current": "T",
  "queue": "IOLJSZ",
  "board": "..........|..........|..........",
  "hold": ""
}
```

`board`는 위에서 아래 순서의 행을 `|`로 이어 붙인 문자열입니다. 각 행은 10칸이어야 하며, `X`, `x`, `#`, `1`은 채워진 칸, `.`, `_`, `0`은 빈 칸입니다.

응답 예시는 다음 형태입니다.

```json
{
  "ok": true,
  "piece": "T",
  "rotation": "North",
  "x": 4,
  "y": 0,
  "spin": "NoSpin",
  "hold_used": false,
  "score": 0.0,
  "cleared": 0,
  "next_board": "..........|..."
}
```

CLI를 직접 실행할 수도 있습니다.

```powershell
.\target\release\quick_best.exe T IOLJSZ
.\target\release\quick_best.exe T IOLJSZ "..........|..........|.........." I
```

## 자동 플레이 사용 흐름

1. Rust 엔진을 release로 빌드합니다.
2. `node .\engine_server.js`로 서버를 켭니다.
3. 다른 터미널에서 자동 플레이를 실행합니다.

```powershell
node .\bot_play_auto_seed.js 10
```

`10`은 자동으로 둘 턴 수입니다.

`bot_play_auto_seed.js`는 `C:\tetrio-bot-profile`을 Chrome persistent profile로 사용합니다. 브라우저에서 직접 로그인하고 커스텀 게임에 들어가면, WebSocket 메시지에서 `seed`, `bagtype`, `nextcount` 같은 게임 옵션을 찾아 큐를 재현합니다. 첫 미노가 조작 가능한 상태가 되면 PowerShell에서 Enter를 눌러 자동 입력을 시작합니다.

주의: 이 자동화는 실제 게임 화면에 키를 입력합니다. 테스트/개인 실험 환경에서만 사용하고, 랭크/공개 매치 등 다른 사용자에게 영향을 주는 환경에서는 사용하지 않는 것이 안전합니다.

## 보조 스크립트

엔진만 시뮬레이션:

```powershell
node .\bot_simulate_seed.js 1234019309 20
```

한 수만 확인:

```powershell
node .\bot_decide_test.js 1234019309 0
```

고정 seed로 실제 브라우저 입력 테스트:

```powershell
node .\bot_play_seed_test.js 1234019309 5
```

WebSocket 조사:

```powershell
node .\tetrio_ws_logger.js
node .\summarize_ws_log.js
```

TETR.IO 스크립트 저장/키워드 조사:

```powershell
node .\capture_tetrio_scripts.js
node .\scan_tetrio_scripts.js
```

## 학습 파이프라인

`training/`에는 policy/value 모델 학습 코드가 있습니다. 현재 문서상 활성 경로는 `.ttrm` 리플레이를 전처리하고, Rust search oracle로 policy/value label을 만든 뒤, Lightning/Modal로 학습하고 ONNX로 export하는 흐름입니다.

```text
.ttrm replays
  -> preprocess_replays.py
  -> training_data.bin + sidecars
  -> generate_policy_value_labels.py
  -> train_policy_value.py / modal_app.py
  -> export_policy_value_onnx.py
  -> models/*.onnx + metadata
```

주요 파일:

| 경로 | 역할 |
| --- | --- |
| `training/TRAINING.md` | 학습 파이프라인 상세 문서입니다. |
| `training/scripts/preprocess_replays.py` | 리플레이를 학습용 binary dataset으로 변환합니다. |
| `training/scripts/generate_policy_value_labels.py` | Rust search oracle 기반 policy/value label을 생성합니다. |
| `training/scripts/train_policy_value.py` | policy/value 모델 학습 엔트리포인트입니다. |
| `training/scripts/export_policy_value_onnx.py` | 학습된 체크포인트를 ONNX로 export합니다. |
| `training/models/policy_value.py` | shared state encoder, candidate policy head, value head 모델입니다. |
| `models/*.metadata.json` | runtime ONNX 계약 메타데이터입니다. 실제 `.onnx` 본체는 `.gitignore` 대상일 수 있습니다. |

Python 의존성은 `training/pyproject.toml`과 `training/uv.lock` 기준입니다.

## 테스트

Rust 테스트:

```powershell
cargo test
```

느린 perft까지 포함:

```powershell
cargo test -- --ignored
```

Python 학습 파이프라인 테스트:

```powershell
cd training
python -m pytest tests/ -v --tb=short
```

`package.json`의 `npm test`는 아직 실제 테스트를 연결하지 않고 에러를 내도록 되어 있습니다. Node 쪽은 현재 개별 스크립트를 직접 실행해 확인하는 형태입니다.

## 현재 상태 메모

- `서버켜기.md`에는 엔진 서버 실행 명령이 간단히 적혀 있지만, 일부 한글 경로가 깨져 보입니다.
- `pw-tetrio-profile/`, `tetrio-scripts/`, `ws-log.jsonl`, `*-snippets.txt` 파일들은 조사/캐시/로그 성격입니다.
- `node_modules/`, `target/`, 브라우저 프로필, 캡처된 TETR.IO 스크립트는 용량이 크므로 문서나 코드 리뷰 시 핵심 소스로 보지 않아도 됩니다.
- 자동 플레이 스크립트의 콘솔 메시지/주석 일부는 인코딩이 깨져 있습니다. 기능 자체와 별개로, 나중에 UTF-8로 정리하면 유지보수가 쉬워집니다.
