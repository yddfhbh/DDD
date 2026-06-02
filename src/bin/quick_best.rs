use direct_cobra_copy::analysis::assemble_composite;
use direct_cobra_copy::attack::{calculate_attack_full, AttackConfig, AttackContext, ComboTable};
use direct_cobra_copy::board::Board;
use direct_cobra_copy::default_ruleset::ACTIVE_RULES;
use direct_cobra_copy::eval::{evaluate, EvalWeights};
use direct_cobra_copy::header::{Move, Piece, Rotation, SpinType, COL_NB, ROW_NB};
use direct_cobra_copy::move_buffer::MoveBuffer;
use direct_cobra_copy::movegen::generate;
use direct_cobra_copy::pathfinder::get_input_names;
use direct_cobra_copy::search::{find_best_move_with_scores, SearchConfig};
use direct_cobra_copy::state::GameState;

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct RoomOptions {
    spinbonuses: Option<String>,
    #[serde(alias = "combo_table")]
    combotable: Option<String>,
    #[serde(alias = "b2b_chaining")]
    b2bcharging: Option<bool>,
    #[serde(alias = "allclear")]
    allclear_garbage: Option<u8>,
    allclear_b2b: Option<u8>,
    #[serde(alias = "garbage_multiplier", alias = "garbageMultiplier")]
    garbagemultiplier: Option<f32>,
}

fn parse_piece(c: char) -> Option<Piece> {
    match c.to_ascii_uppercase() {
        'I' => Some(Piece::I),
        'O' => Some(Piece::O),
        'T' => Some(Piece::T),
        'S' => Some(Piece::S),
        'Z' => Some(Piece::Z),
        'J' => Some(Piece::J),
        'L' => Some(Piece::L),
        _ => None,
    }
}

fn board_from_visual(input: &str) -> Result<Board, String> {
    let mut board = Board::new();

    if input.trim().is_empty() {
        return Ok(board);
    }

    let rows: Vec<&str> = input.split('|').collect();

    if rows.len() > 40 {
        return Err("board_too_tall".to_string());
    }

    for (y, row) in rows.iter().rev().enumerate() {
        let chars: Vec<char> = row.chars().collect();

        if chars.len() != 10 {
            return Err(format!("row_must_have_10_cells:{}", row));
        }

        let mut mask: u16 = 0;

        for (x, ch) in chars.iter().enumerate() {
            match ch {
                'X' | 'x' | '#' | '1' => {
                    mask |= 1u16 << x;
                    board.cols[x] |= 1u64 << y;
                }
                '.' | '_' | '0' => {}
                _ => {
                    return Err(format!("unknown_board_char:{}", ch));
                }
            }
        }

        board.rows[y] = mask;
    }

    Ok(board)
}

fn board_to_visual(board: &Board) -> String {
    let mut rows: Vec<String> = Vec::new();

    for y in (0..20).rev() {
        let mut row = String::new();

        for x in 0..10 {
            if board.occupied(x, y) {
                row.push('X');
            } else {
                row.push('.');
            }
        }

        rows.push(row);
    }

    rows.join("|")
}

fn print_json_error(error: &str) {
    println!("{{\"ok\":false,\"error\":\"{}\"}}", error);
}

fn input_names_for_move(board: &Board, target: &Move) -> Vec<&'static str> {
    let mut inputs = get_input_names(board, target, true, false);
    if inputs.is_empty() {
        inputs = get_input_names(board, target, false, false);
    }
    if inputs.is_empty() {
        inputs = get_input_names(board, target, true, true);
    }
    if inputs.is_empty() {
        inputs = get_input_names(board, target, false, true);
    }
    inputs
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SoftDropMode {
    Allow,
    Forbid,
    GroundedSpinOnly,
}

struct CliOptions {
    args: Vec<String>,
    softdrop_mode: SoftDropMode,
    room_options_json: Option<String>,
}

fn parse_cli_options(raw_args: Vec<String>) -> CliOptions {
    let mut args = Vec::new();
    let mut softdrop_mode = SoftDropMode::Allow;
    let mut room_options_json = None;

    if let Some(program) = raw_args.first() {
        args.push(program.clone());
    }

    let mut i = 1;
    while i < raw_args.len() {
        match raw_args[i].as_str() {
            "--no-softdrop" => softdrop_mode = SoftDropMode::Forbid,
            "--grounded-softdrop-spins" => softdrop_mode = SoftDropMode::GroundedSpinOnly,
            "--options-json" => {
                if let Some(value) = raw_args.get(i + 1) {
                    room_options_json = Some(value.clone());
                    i += 1;
                }
            }
            other if other.starts_with("--") => {}
            _ => args.push(raw_args[i].clone()),
        }

        i += 1;
    }

    CliOptions {
        args,
        softdrop_mode,
        room_options_json,
    }
}

fn combo_table_from_room_value(value: &str) -> ComboTable {
    match value.trim().to_ascii_lowercase().as_str() {
        "classic" => ComboTable::Classic,
        "modern" => ComboTable::Modern,
        "none" | "off" | "false" | "disabled" | "disable" | "0" => ComboTable::None,
        _ => ComboTable::Multiplier,
    }
}

fn attack_config_from_room_options(options: Option<&RoomOptions>) -> AttackConfig {
    let mut config = AttackConfig::tetra_league();

    let Some(options) = options else {
        return config;
    };

    if let Some(pc_garbage) = options.allclear_garbage {
        config.pc_garbage = pc_garbage;
    }

    if let Some(pc_b2b) = options.allclear_b2b {
        config.pc_b2b = pc_b2b;
    }

    if let Some(b2b_chaining) = options.b2bcharging {
        config.b2b_chaining = b2b_chaining;
    }

    if let Some(combo_table) = options.combotable.as_deref() {
        config.combo_table = combo_table_from_room_value(combo_table);
    }

    if let Some(multiplier) = options.garbagemultiplier {
        config.garbage_multiplier = multiplier;
    }

    config
}

fn search_config_from_room_options(options_json: Option<&str>) -> Result<SearchConfig, String> {
    let room_options = match options_json {
        Some(json) if !json.trim().is_empty() => Some(
            serde_json::from_str::<RoomOptions>(json)
                .map_err(|err| format!("room_options_parse_failed:{}", err))?,
        ),
        _ => None,
    };

    let mut config = SearchConfig {
        attack_config: attack_config_from_room_options(room_options.as_ref()),
        ..SearchConfig::default()
    };

    apply_ai_profile_to_search_config(&mut config);

    if let Some(ms) = std::env::var("TETRIO_BOT_SEARCH_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        config.time_budget_ms = Some(ms);
    }

    Ok(config)
}

fn ai_profile() -> String {
    std::env::var("TETRIO_BOT_AI_PROFILE")
        .unwrap_or_else(|_| "stable".to_string())
        .trim()
        .to_ascii_lowercase()
}

fn apply_ai_profile_to_search_config(config: &mut SearchConfig) {
    match ai_profile().as_str() {
        "github" | "default" | "original" => {}
        "safe" | "survival" => {
            config.board_weight = 1.35;
            config.attack_weight = 0.28;
            config.chain_weight = 0.08;
            config.context_weight = 0.05;
            config.policy_bonus_weight = 0.05;
            config.futility_delta = 25.0;
        }
        _ => {
            config.board_weight = 1.15;
            config.attack_weight = 0.55;
            config.chain_weight = 0.12;
            config.context_weight = 0.08;
            config.policy_bonus_weight = 0.05;
            config.futility_delta = 25.0;
        }
    }
}

fn eval_weights_for_ai_profile() -> EvalWeights {
    let mut weights = EvalWeights::default();

    match ai_profile().as_str() {
        "github" | "default" | "original" => weights,
        "safe" | "survival" => {
            weights.holes = -6.5;
            weights.cell_coveredness = -0.9;
            weights.height = -0.35;
            weights.height_upper_half = -1.8;
            weights.height_upper_quarter = -8.0;
            weights.bumpiness = -0.45;
            weights.bumpiness_sq = -0.14;
            weights.row_transitions = -0.55;
            weights.well_depth = 0.12;
            weights.tsd_overhang = 2.0;
            weights.four_wide_well = 0.25;
            weights
        }
        _ => {
            weights.holes = -5.6;
            weights.cell_coveredness = -0.75;
            weights.height = -0.30;
            weights.height_upper_half = -1.45;
            weights.height_upper_quarter = -6.75;
            weights.bumpiness = -0.45;
            weights.bumpiness_sq = -0.14;
            weights.row_transitions = -0.50;
            weights.well_depth = 0.18;
            weights.tsd_overhang = 4.5;
            weights.four_wide_well = 0.75;
            weights
        }
    }
}

fn is_rotation_input(input: &str) -> bool {
    matches!(input, "RotateCw" | "RotateCcw" | "RotateFlip")
}

fn direct_spawn_x_after_piece_rotation(piece: Piece, rotation: Rotation) -> i32 {
    if piece != Piece::I {
        return 4;
    }

    match rotation {
        // In this engine/TETR.IO SRS+ table, the first unobstructed I 0->R and
        // 0->2 kicks shift the pivot right by one. Direct tap paths need to
        // account for that or the live piece lands one column off.
        Rotation::East | Rotation::South => 5,
        Rotation::North | Rotation::West => 4,
    }
}

fn direct_spawn_x_after_rotation(mv: &Move) -> i32 {
    direct_spawn_x_after_piece_rotation(mv.piece(), mv.rotation())
}

fn direct_inputs_for_nospin(mv: &Move) -> Vec<&'static str> {
    let mut inputs = Vec::new();

    push_rotation_inputs(&mut inputs, mv.rotation());
    push_horizontal_inputs_from(&mut inputs, direct_spawn_x_after_rotation(mv), mv.x());
    inputs.push("HardDrop");
    inputs
}

fn push_rotation_inputs(inputs: &mut Vec<&'static str>, rotation: Rotation) {
    match rotation {
        Rotation::North => {}
        Rotation::East => inputs.push("RotateCw"),
        Rotation::South => inputs.push("RotateFlip"),
        Rotation::West => inputs.push("RotateCcw"),
    }
}

fn push_horizontal_inputs(inputs: &mut Vec<&'static str>, x: i32) {
    push_horizontal_inputs_from(inputs, 4, x);
}

fn push_horizontal_inputs_from(inputs: &mut Vec<&'static str>, start_x: i32, target_x: i32) {
    let dx = target_x - start_x;
    if dx < 0 {
        for _ in 0..(-dx) {
            inputs.push("ShiftLeft");
        }
    } else {
        for _ in 0..dx {
            inputs.push("ShiftRight");
        }
    }
}

fn fallback_inputs_for_spin(mv: &Move) -> Vec<&'static str> {
    let mut inputs = Vec::new();
    push_horizontal_inputs(&mut inputs, mv.x());
    inputs.push("SoftDrop");
    match mv.rotation() {
        Rotation::North => {
            inputs.push("RotateCw");
            inputs.push("RotateCcw");
        }
        rotation => push_rotation_inputs(&mut inputs, rotation),
    }
    inputs.push("HardDrop");
    inputs
}

fn normalize_grounded_softdrop_spin_path(
    inputs: &[&'static str],
    mv: &Move,
) -> Option<Vec<&'static str>> {
    if mv.spin() == SpinType::NoSpin {
        return None;
    }

    let Some(first_softdrop) = inputs.iter().position(|input| *input == "SoftDrop") else {
        return Some(inputs.to_vec());
    };

    let mut normalized: Vec<&'static str> = inputs[..first_softdrop]
        .iter()
        .copied()
        .filter(|input| *input != "NoInput")
        .collect();
    let mut saw_rotation_after_softdrop = false;
    let mut saw_harddrop = false;

    normalized.push("SoftDrop");

    for input in inputs.iter().skip(first_softdrop + 1) {
        match *input {
            "SoftDrop" | "NoInput" => {}
            "HardDrop" => {
                saw_harddrop = true;
                break;
            }
            other if is_rotation_input(other) => {
                normalized.push(other);
                saw_rotation_after_softdrop = true;
            }
            _ => return None,
        }
    }

    if !saw_rotation_after_softdrop {
        return None;
    }

    if !saw_harddrop || normalized.last().copied() != Some("HardDrop") {
        normalized.push("HardDrop");
    }

    Some(normalized)
}

fn compress_softdrop_run(inputs: &[&'static str]) -> Vec<&'static str> {
    let mut normalized = Vec::new();
    let mut previous_softdrop = false;

    for input in inputs {
        if *input == "SoftDrop" {
            if !previous_softdrop {
                normalized.push(*input);
            }
            previous_softdrop = true;
        } else {
            normalized.push(*input);
            previous_softdrop = false;
        }
    }

    normalized
}

fn normalize_inputs_for_mode(
    inputs: &[&'static str],
    mv: &Move,
    softdrop_mode: SoftDropMode,
) -> Vec<&'static str> {
    if inputs.is_empty() {
        return if mv.spin() == SpinType::NoSpin {
            direct_inputs_for_nospin(mv)
        } else {
            fallback_inputs_for_spin(mv)
        };
    }

    if mv.spin() == SpinType::NoSpin {
        return direct_inputs_for_nospin(mv);
    }

    let has_softdrop = inputs.iter().any(|input| *input == "SoftDrop");

    if !has_softdrop {
        return inputs.to_vec();
    }

    match softdrop_mode {
        SoftDropMode::Allow => inputs.to_vec(),
        SoftDropMode::Forbid => compress_softdrop_run(inputs),
        SoftDropMode::GroundedSpinOnly => normalize_grounded_softdrop_spin_path(inputs, mv)
            .unwrap_or_else(|| compress_softdrop_run(inputs)),
    }
}

#[derive(Clone, Copy)]
struct SimCoord {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SimRotationInput {
    Cw,
    Ccw,
    Flip,
}

#[derive(Clone, Copy)]
struct SimPieceState {
    piece: Piece,
    rotation: Rotation,
    x: i32,
    y: i32,
    spin: SpinType,
}

macro_rules! sc {
    ($x:expr, $y:expr) => {
        SimCoord { x: $x, y: $y }
    };
}

const KICKS_NORMAL: [[[SimCoord; 5]; 4]; 2] = [
    [
        [sc!(0, 0), sc!(-1, 0), sc!(-1, 1), sc!(0, -2), sc!(-1, -2)],
        [sc!(0, 0), sc!(1, 0), sc!(1, -1), sc!(0, 2), sc!(1, 2)],
        [sc!(0, 0), sc!(1, 0), sc!(1, 1), sc!(0, -2), sc!(1, -2)],
        [sc!(0, 0), sc!(-1, 0), sc!(-1, -1), sc!(0, 2), sc!(-1, 2)],
    ],
    [
        [sc!(0, 0), sc!(1, 0), sc!(1, 1), sc!(0, -2), sc!(1, -2)],
        [sc!(0, 0), sc!(1, 0), sc!(1, -1), sc!(0, 2), sc!(1, 2)],
        [sc!(0, 0), sc!(-1, 0), sc!(-1, 1), sc!(0, -2), sc!(-1, -2)],
        [sc!(0, 0), sc!(-1, 0), sc!(-1, -1), sc!(0, 2), sc!(-1, 2)],
    ],
];

const KICKS_I_SRS: [[[SimCoord; 5]; 4]; 2] = [
    [
        [sc!(1, 0), sc!(-1, 0), sc!(2, 0), sc!(-1, -1), sc!(2, 2)],
        [sc!(0, -1), sc!(-1, -1), sc!(2, -1), sc!(-1, 1), sc!(2, -2)],
        [sc!(-1, 0), sc!(1, 0), sc!(-2, 0), sc!(1, 1), sc!(-2, -2)],
        [sc!(0, 1), sc!(1, 1), sc!(-2, 1), sc!(1, -1), sc!(-2, 2)],
    ],
    [
        [sc!(0, -1), sc!(-1, -1), sc!(2, -1), sc!(-1, 1), sc!(2, -2)],
        [sc!(-1, 0), sc!(1, 0), sc!(-2, 0), sc!(1, 1), sc!(-2, -2)],
        [sc!(0, 1), sc!(1, 1), sc!(-2, 1), sc!(1, -1), sc!(-2, 2)],
        [sc!(1, 0), sc!(-1, 0), sc!(2, 0), sc!(-1, -1), sc!(2, 2)],
    ],
];

const KICKS_I_SRS_PLUS: [[[SimCoord; 5]; 4]; 2] = [
    [
        [sc!(1, 0), sc!(2, 0), sc!(-1, 0), sc!(-1, -1), sc!(2, 2)],
        [sc!(0, -1), sc!(-1, -1), sc!(2, -1), sc!(-1, 1), sc!(2, -2)],
        [sc!(-1, 0), sc!(1, 0), sc!(-2, 0), sc!(1, 1), sc!(-2, -2)],
        [sc!(0, 1), sc!(1, 1), sc!(-2, 1), sc!(1, -1), sc!(-2, 2)],
    ],
    [
        [sc!(0, -1), sc!(-1, -1), sc!(2, -1), sc!(2, -2), sc!(-1, 1)],
        [sc!(-1, 0), sc!(-2, 0), sc!(1, 0), sc!(-2, -2), sc!(1, 1)],
        [sc!(0, 1), sc!(-2, 1), sc!(1, 1), sc!(-2, 2), sc!(1, -1)],
        [sc!(1, 0), sc!(2, 0), sc!(-1, 0), sc!(2, 2), sc!(-1, -1)],
    ],
];

const KICKS_180_NORMAL: [[SimCoord; 6]; 4] = [
    [
        sc!(0, 0),
        sc!(0, 1),
        sc!(1, 1),
        sc!(-1, 1),
        sc!(1, 0),
        sc!(-1, 0),
    ],
    [
        sc!(0, 0),
        sc!(1, 0),
        sc!(1, 2),
        sc!(1, 1),
        sc!(0, 2),
        sc!(0, 1),
    ],
    [
        sc!(0, 0),
        sc!(0, -1),
        sc!(-1, -1),
        sc!(1, -1),
        sc!(-1, 0),
        sc!(1, 0),
    ],
    [
        sc!(0, 0),
        sc!(-1, 0),
        sc!(-1, 2),
        sc!(-1, 1),
        sc!(0, 2),
        sc!(0, 1),
    ],
];

const KICKS_180_I: [[SimCoord; 6]; 4] = [
    [
        sc!(1, -1),
        sc!(1, 0),
        sc!(2, 0),
        sc!(0, 0),
        sc!(2, -1),
        sc!(0, -1),
    ],
    [
        sc!(-1, -1),
        sc!(0, -1),
        sc!(0, 1),
        sc!(0, 0),
        sc!(-1, 1),
        sc!(-1, 0),
    ],
    [
        sc!(-1, 1),
        sc!(-1, 0),
        sc!(-2, 0),
        sc!(0, 0),
        sc!(-2, 1),
        sc!(0, 1),
    ],
    [
        sc!(1, 1),
        sc!(0, 1),
        sc!(0, 3),
        sc!(0, 2),
        sc!(1, 3),
        sc!(1, 2),
    ],
];

fn rotate_sim(rotation: Rotation, input: SimRotationInput) -> Rotation {
    let value = rotation as u8;
    let next = match input {
        SimRotationInput::Cw => (value + 1) & 3,
        SimRotationInput::Ccw => (value + 3) & 3,
        SimRotationInput::Flip => (value + 2) & 3,
    };
    Rotation::from_u8(next)
}

fn sim_canonical_offset(piece: Piece, rotation: Rotation) -> SimCoord {
    match piece {
        Piece::I => match rotation {
            Rotation::South => sc!(1, 0),
            Rotation::West => sc!(0, -1),
            _ => sc!(0, 0),
        },
        Piece::S | Piece::Z => match rotation {
            Rotation::South => sc!(0, 1),
            Rotation::West => sc!(1, 0),
            _ => sc!(0, 0),
        },
        _ => sc!(0, 0),
    }
}

fn rotation_kicks(
    piece: Piece,
    rotation: Rotation,
    input: SimRotationInput,
) -> &'static [SimCoord] {
    if input == SimRotationInput::Flip {
        let kicks = if piece == Piece::I {
            &KICKS_180_I[rotation as usize]
        } else {
            &KICKS_180_NORMAL[rotation as usize]
        };
        return if ACTIVE_RULES.srs_plus {
            &kicks[..]
        } else {
            &kicks[..2]
        };
    }

    let dir = match input {
        SimRotationInput::Cw => 0,
        SimRotationInput::Ccw => 1,
        SimRotationInput::Flip => unreachable!(),
    };

    if piece == Piece::I {
        if ACTIVE_RULES.srs_plus {
            &KICKS_I_SRS_PLUS[dir][rotation as usize]
        } else {
            &KICKS_I_SRS[dir][rotation as usize]
        }
    } else {
        &KICKS_NORMAL[dir][rotation as usize]
    }
}

fn obstructed_at(board: &Board, piece: Piece, rotation: Rotation, x: i32, y: i32) -> bool {
    board.obstructed_move(&Move::new(piece, rotation, x, y, false))
}

fn grounded_drop_y(board: &Board, piece: Piece, rotation: Rotation, x: i32, mut y: i32) -> i32 {
    while y > 0 && !obstructed_at(board, piece, rotation, x, y - 1) {
        y -= 1;
    }
    y
}

fn occupied_or_wall(board: &Board, x: i32, y: i32) -> bool {
    x < 0 || x >= COL_NB as i32 || y < 0 || board.occupied(x, y)
}

fn detect_rotation_spin(board: &Board, state: &SimPieceState, kick_index: usize) -> SpinType {
    let piece = state.piece;

    if piece == Piece::T {
        let mut corners = 0u32;
        for (dx, dy) in [(-1, -1), (1, -1), (-1, 1), (1, 1)] {
            if occupied_or_wall(board, state.x + dx, state.y + dy) {
                corners += 1;
            }
        }

        if corners < 3 {
            return SpinType::NoSpin;
        }

        let face = match state.rotation {
            Rotation::North => [(0, -1), (0, 1)],
            Rotation::East => [(-1, 0), (1, 0)],
            Rotation::South => [(0, -1), (0, 1)],
            Rotation::West => [(-1, 0), (1, 0)],
        };

        let face_filled = face
            .into_iter()
            .filter(|(dx, dy)| occupied_or_wall(board, state.x + dx, state.y + dy))
            .count();

        if face_filled >= 2 || kick_index == 4 {
            SpinType::Full
        } else {
            SpinType::Mini
        }
    } else if piece != Piece::O {
        let blocked_left =
            state.x == 0 || obstructed_at(board, piece, state.rotation, state.x - 1, state.y);
        let blocked_right = state.x >= COL_NB as i32 - 1
            || obstructed_at(board, piece, state.rotation, state.x + 1, state.y);
        let blocked_down =
            state.y <= 0 || obstructed_at(board, piece, state.rotation, state.x, state.y - 1);
        let blocked_up = state.y >= ROW_NB as i32 - 1
            || obstructed_at(board, piece, state.rotation, state.x, state.y + 1);

        if blocked_left && blocked_right && blocked_down && blocked_up {
            SpinType::Mini
        } else {
            SpinType::NoSpin
        }
    } else {
        SpinType::NoSpin
    }
}

fn apply_rotation(board: &Board, state: &mut SimPieceState, rotation_input: SimRotationInput) {
    if state.piece == Piece::O {
        return;
    }

    let next_rotation = rotate_sim(state.rotation, rotation_input);
    let from_offset = sim_canonical_offset(state.piece, state.rotation);
    let to_offset = sim_canonical_offset(state.piece, next_rotation);
    let offset = sc!(from_offset.x - to_offset.x, from_offset.y - to_offset.y);

    for (kick_index, kick) in rotation_kicks(state.piece, state.rotation, rotation_input)
        .iter()
        .enumerate()
    {
        let next_x = state.x + kick.x + offset.x;
        let next_y = state.y + kick.y + offset.y;

        if obstructed_at(board, state.piece, next_rotation, next_x, next_y) {
            continue;
        }

        state.rotation = next_rotation;
        state.x = next_x;
        state.y = next_y;
        state.spin = detect_rotation_spin(board, state, kick_index);
        return;
    }
}

fn apply_shift(board: &Board, state: &mut SimPieceState, dx: i32) {
    let next_x = state.x + dx;
    if !obstructed_at(board, state.piece, state.rotation, next_x, state.y) {
        state.x = next_x;
        state.spin = SpinType::NoSpin;
    }
}

fn apply_das(board: &Board, state: &mut SimPieceState, dx: i32) {
    loop {
        let before = state.x;
        apply_shift(board, state, dx);
        if state.x == before {
            break;
        }
    }
}

fn grounded_inputs_match_target(board: &Board, inputs: &[&'static str], target: &Move) -> bool {
    let mut state = SimPieceState {
        piece: target.piece(),
        rotation: Rotation::North,
        x: 4,
        y: ACTIVE_RULES.spawn_row,
        spin: SpinType::NoSpin,
    };

    if obstructed_at(board, state.piece, state.rotation, state.x, state.y) {
        return false;
    }

    for input in inputs {
        match *input {
            "NoInput" => {}
            "ShiftLeft" => apply_shift(board, &mut state, -1),
            "ShiftRight" => apply_shift(board, &mut state, 1),
            "DasLeft" => apply_das(board, &mut state, -1),
            "DasRight" => apply_das(board, &mut state, 1),
            "RotateCw" => apply_rotation(board, &mut state, SimRotationInput::Cw),
            "RotateCcw" => apply_rotation(board, &mut state, SimRotationInput::Ccw),
            "RotateFlip" => apply_rotation(board, &mut state, SimRotationInput::Flip),
            "SoftDrop" => {
                state.y = grounded_drop_y(board, state.piece, state.rotation, state.x, state.y);
            }
            "HardDrop" => {
                state.y = grounded_drop_y(board, state.piece, state.rotation, state.x, state.y);
                let spin_matches = target.spin() == SpinType::NoSpin || state.spin == target.spin();
                return state.x == target.x()
                    && state.y == target.y()
                    && state.rotation == target.rotation()
                    && spin_matches;
            }
            _ => return false,
        }
    }

    false
}

fn rotation_sequence_inputs(rotation: Rotation) -> Vec<&'static str> {
    let mut inputs = Vec::new();
    push_rotation_inputs(&mut inputs, rotation);
    inputs
}

fn grounded_spin_rotation_sequences() -> Vec<Vec<&'static str>> {
    vec![
        vec!["RotateCw"],
        vec!["RotateCcw"],
        vec!["RotateFlip"],
        vec!["RotateCw", "RotateCw"],
        vec!["RotateCcw", "RotateCcw"],
        vec!["RotateCw", "RotateCcw"],
        vec!["RotateCcw", "RotateCw"],
        vec!["RotateFlip", "RotateFlip"],
        vec!["RotateFlip", "RotateCw"],
        vec!["RotateFlip", "RotateCcw"],
    ]
}

fn allspin_piece_needs_stable_entry(piece: Piece) -> bool {
    !matches!(piece, Piece::I | Piece::O | Piece::T)
}

fn grounded_spin_path_preference_score(
    target: &Move,
    pre_rotation: Rotation,
    final_rotations: &[&'static str],
    input_len: usize,
) -> usize {
    if !allspin_piece_needs_stable_entry(target.piece()) {
        return input_len;
    }

    let single_rotation_penalty = if final_rotations.len() == 1 { 20 } else { 0 };
    let off_rotation_entry_penalty = if pre_rotation != target.rotation() {
        8
    } else {
        0
    };

    input_len + single_rotation_penalty + off_rotation_entry_penalty
}

fn horizontal_entry_sequences_from(start_x: i32, target_x: i32) -> Vec<Vec<&'static str>> {
    let mut sequences = Vec::new();
    let mut taps = Vec::new();
    push_horizontal_inputs_from(&mut taps, start_x, target_x);
    sequences.push(taps);

    if target_x <= 0 {
        sequences.push(vec!["DasLeft"]);
    }

    if target_x >= COL_NB as i32 - 1 {
        sequences.push(vec!["DasRight"]);
    }

    sequences
}

fn grounded_spin_fallback_inputs(board: &Board, target: &Move) -> Option<Vec<&'static str>> {
    if target.spin() == SpinType::NoSpin {
        return None;
    }

    let piece = target.piece();
    let mut best: Option<(Vec<&'static str>, usize)> = None;

    for pre_rotation in [
        Rotation::North,
        Rotation::East,
        Rotation::South,
        Rotation::West,
    ] {
        let rotation_prefix = rotation_sequence_inputs(pre_rotation);
        let start_x = direct_spawn_x_after_piece_rotation(piece, pre_rotation);

        for pre_x in 0..COL_NB as i32 {
            for horizontal_inputs in horizontal_entry_sequences_from(start_x, pre_x) {
                let mut prefix = rotation_prefix.clone();
                prefix.extend(horizontal_inputs.iter().copied());

                for final_rotations in grounded_spin_rotation_sequences() {
                    let mut inputs = prefix.clone();
                    inputs.push("SoftDrop");
                    inputs.extend(final_rotations.iter().copied());
                    inputs.push("HardDrop");

                    if grounded_inputs_match_target(board, &inputs, target) {
                        let preference_score = grounded_spin_path_preference_score(
                            target,
                            pre_rotation,
                            &final_rotations,
                            inputs.len(),
                        );

                        if best
                            .as_ref()
                            .is_none_or(|(_, best_score)| preference_score < *best_score)
                        {
                            best = Some((inputs, preference_score));
                        }
                    }
                }
            }
        }
    }

    best.map(|(inputs, _)| inputs)
}

fn grounded_nospin_post_shift_sequences() -> Vec<Vec<&'static str>> {
    let mut sequences = vec![Vec::new()];

    for count in 1..=COL_NB {
        sequences.push(vec!["ShiftLeft"; count]);
        sequences.push(vec!["ShiftRight"; count]);
    }

    sequences
}

fn grounded_nospin_fallback_inputs(board: &Board, target: &Move) -> Option<Vec<&'static str>> {
    if target.spin() != SpinType::NoSpin {
        return None;
    }

    let piece = target.piece();
    let mut best: Option<(Vec<&'static str>, usize)> = None;

    for pre_rotation in [
        Rotation::North,
        Rotation::East,
        Rotation::South,
        Rotation::West,
    ] {
        let mut prefix = rotation_sequence_inputs(pre_rotation);
        let start_x = direct_spawn_x_after_piece_rotation(piece, pre_rotation);

        for pre_x in 0..COL_NB as i32 {
            let prefix_len = prefix.len();
            push_horizontal_inputs_from(&mut prefix, start_x, pre_x);

            for post_shifts in grounded_nospin_post_shift_sequences() {
                let mut inputs = prefix.clone();
                inputs.push("SoftDrop");
                inputs.extend(post_shifts.iter().copied());
                inputs.push("HardDrop");

                if grounded_inputs_match_target(board, &inputs, target) {
                    let preference_score = inputs.len() + post_shifts.len() * 8;

                    if best
                        .as_ref()
                        .is_none_or(|(_, best_score)| preference_score < *best_score)
                    {
                        best = Some((inputs, preference_score));
                    }
                }
            }

            prefix.truncate(prefix_len);
        }
    }

    best.map(|(inputs, _)| inputs)
}

fn input_sequence_supported(
    board: &Board,
    inputs: &[&'static str],
    mv: &Move,
    softdrop_mode: SoftDropMode,
) -> bool {
    let has_softdrop = inputs.iter().any(|input| *input == "SoftDrop");

    match softdrop_mode {
        SoftDropMode::Allow => true,
        SoftDropMode::Forbid => !has_softdrop && grounded_inputs_match_target(board, inputs, mv),
        SoftDropMode::GroundedSpinOnly => grounded_inputs_match_target(board, inputs, mv),
    }
}

fn supported_or_grounded_spin_fallback(
    board: &Board,
    inputs: Vec<&'static str>,
    mv: &Move,
    softdrop_mode: SoftDropMode,
) -> Option<Vec<&'static str>> {
    if softdrop_mode == SoftDropMode::GroundedSpinOnly
        && mv.spin() != SpinType::NoSpin
        && allspin_piece_needs_stable_entry(mv.piece())
    {
        if let Some(fallback) = grounded_spin_fallback_inputs(board, mv) {
            return Some(fallback);
        }
    }

    if input_sequence_supported(board, &inputs, mv, softdrop_mode) {
        return Some(inputs);
    }

    if softdrop_mode == SoftDropMode::GroundedSpinOnly {
        return if mv.spin() == SpinType::NoSpin {
            grounded_nospin_fallback_inputs(board, mv)
        } else {
            grounded_spin_fallback_inputs(board, mv)
        };
    }

    None
}

fn spin_bias() -> f32 {
    std::env::var("TETRIO_BOT_SPIN_BIAS")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .unwrap_or(1.6)
}

fn spin_preference_bonus(mv: &Move, cleared: i32) -> f32 {
    if mv.spin() == SpinType::NoSpin {
        return 0.0;
    }

    let clear_count = cleared.max(0) as f32;
    let base = match mv.spin() {
        SpinType::NoSpin => 0.0,
        SpinType::Mini if cleared > 0 => 0.8,
        SpinType::Mini => 0.25,
        SpinType::Full if cleared > 0 => 2.0,
        SpinType::Full => 0.75,
    };
    let clear_bonus = match mv.spin() {
        SpinType::NoSpin => 0.0,
        SpinType::Mini => 0.7 * clear_count,
        SpinType::Full => 1.4 * clear_count,
    };
    let piece_bonus = match (mv.piece(), mv.spin(), cleared > 0) {
        (Piece::T, SpinType::Full, true) => 0.8,
        (Piece::T, _, true) => 0.45,
        (_, _, true) => 0.2,
        _ => 0.0,
    };

    (base + clear_bonus + piece_bonus) * spin_bias().max(0.0)
}

fn spin_override_margin() -> f32 {
    std::env::var("TETRIO_BOT_SPIN_OVERRIDE_MARGIN")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .unwrap_or(8.0)
}

fn adjusted_candidate_score(board: &Board, mv: &Move, search_score: f32) -> f32 {
    let mut next_board = board.clone();
    let cleared = next_board.do_move(mv);
    search_score + spin_preference_bonus(mv, cleared)
}

fn immediate_spin_candidate_score(
    state: &GameState,
    weights: &EvalWeights,
    config: &SearchConfig,
    mv: &Move,
) -> Option<f32> {
    if mv.spin() == SpinType::NoSpin {
        return None;
    }

    let mut next_board = state.board.clone();
    let cleared = next_board.do_move(mv);
    if cleared <= 0 {
        return None;
    }

    let lines = cleared as u8;
    let next_pending_garbage = state.pending_garbage.saturating_sub(lines);
    let (next_b2b, next_combo) = GameState::next_chain_values(state.b2b, state.combo, mv, lines);
    let b2b_broken_from = if state.b2b >= 4 && next_b2b == 0 && lines > 0 {
        Some(state.b2b)
    } else {
        None
    };
    let clears_garbage = state.pending_garbage > 0 && next_pending_garbage < state.pending_garbage;
    let attack = calculate_attack_full(&AttackContext {
        lines,
        spin: mv.spin(),
        b2b: next_b2b,
        combo: next_combo as u8,
        config: &config.attack_config,
        is_perfect_clear: next_board.is_empty(),
        b2b_broken_from,
        clears_garbage,
    });
    let board_score = evaluate(&next_board, weights);
    let score = assemble_composite(board_score, attack, next_combo as f32, 0.0, config)
        + spin_preference_bonus(mv, cleared);

    Some(score)
}

fn candidate_with_input_path(
    board: &Board,
    mv: Move,
    hold_used: bool,
    score: f32,
    softdrop_mode: SoftDropMode,
) -> Option<(Move, bool, f32, Vec<&'static str>)> {
    let inputs = input_names_for_move(board, &mv);
    let inputs = normalize_inputs_for_mode(&inputs, &mv, softdrop_mode);

    if let Some(inputs) = supported_or_grounded_spin_fallback(board, inputs, &mv, softdrop_mode) {
        Some((mv, hold_used, score, inputs))
    } else {
        None
    }
}

fn maybe_update_choice(
    choice: &mut Option<(Move, bool, f32, Vec<&'static str>, f32)>,
    board: &Board,
    candidate: (Move, bool, f32, Vec<&'static str>),
) {
    let adjusted_score = adjusted_candidate_score(board, &candidate.0, candidate.2);

    if choice
        .as_ref()
        .is_none_or(|(_, _, _, _, best_adjusted)| adjusted_score > *best_adjusted)
    {
        *choice = Some((
            candidate.0,
            candidate.1,
            candidate.2,
            candidate.3,
            adjusted_score,
        ));
    }
}

fn infer_hold_used_for_root(state: &GameState, mv: &Move) -> bool {
    mv.piece() != state.current
}

fn consider_spin_override_piece(
    choice: &mut Option<(Move, bool, f32, Vec<&'static str>, f32)>,
    state: &GameState,
    piece: Piece,
    hold_used: bool,
    weights: &EvalWeights,
    config: &SearchConfig,
    softdrop_mode: SoftDropMode,
) {
    let mut moves = MoveBuffer::new();
    generate(&state.board, &mut moves, piece, true);

    for mv in moves.as_slice() {
        if mv.spin() == SpinType::NoSpin || !state.board.legal_lock_placement(mv) {
            continue;
        }

        let Some(score) = immediate_spin_candidate_score(state, weights, config, mv) else {
            continue;
        };

        let Some(candidate) =
            candidate_with_input_path(&state.board, *mv, hold_used, score, softdrop_mode)
        else {
            continue;
        };

        let adjusted = adjusted_candidate_score(&state.board, &candidate.0, candidate.2);
        let should_replace = match choice.as_ref() {
            None => true,
            Some((best_move, _, _, _, best_adjusted)) if best_move.spin() == SpinType::NoSpin => {
                adjusted >= *best_adjusted - spin_override_margin()
            }
            Some((_, _, _, _, best_adjusted)) => adjusted > *best_adjusted,
        };

        if should_replace {
            *choice = Some((candidate.0, candidate.1, candidate.2, candidate.3, adjusted));
        }
    }
}

fn consider_spin_overrides(
    choice: &mut Option<(Move, bool, f32, Vec<&'static str>, f32)>,
    state: &GameState,
    weights: &EvalWeights,
    config: &SearchConfig,
    softdrop_mode: SoftDropMode,
) {
    consider_spin_override_piece(
        choice,
        state,
        state.current,
        false,
        weights,
        config,
        softdrop_mode,
    );

    if let Some(held) = state.hold {
        consider_spin_override_piece(choice, state, held, true, weights, config, softdrop_mode);
    } else if let Some(&next) = state.queue.first() {
        consider_spin_override_piece(choice, state, next, true, weights, config, softdrop_mode);
    }
}

fn best_move_with_input_path(
    state: &GameState,
    result: &direct_cobra_copy::search::SearchResultFull,
    weights: &EvalWeights,
    config: &SearchConfig,
    softdrop_mode: SoftDropMode,
) -> Option<(Move, bool, f32, Vec<&'static str>)> {
    let board = &state.board;
    let mut choice: Option<(Move, bool, f32, Vec<&'static str>, f32)> = None;

    if let Some(candidate) = candidate_with_input_path(
        board,
        result.best.best_move,
        result.best.hold_used,
        result.best.score,
        softdrop_mode,
    ) {
        maybe_update_choice(&mut choice, board, candidate);
    }

    for (mv, score) in &result.root_scores {
        if mv.raw() == result.best.best_move.raw() {
            continue;
        }

        let hold_used = infer_hold_used_for_root(state, mv);
        if let Some(candidate) =
            candidate_with_input_path(board, *mv, hold_used, *score, softdrop_mode)
        {
            maybe_update_choice(&mut choice, board, candidate);
        }
    }

    consider_spin_overrides(&mut choice, state, weights, config, softdrop_mode);

    choice.map(|(mv, hold_used, score, inputs, _)| (mv, hold_used, score, inputs))
}

fn consider_any_input_piece(
    best: &mut Option<(Move, bool, f32, Vec<&'static str>)>,
    board: &Board,
    piece: Piece,
    hold_used: bool,
    weights: &EvalWeights,
) {
    let mut moves = MoveBuffer::new();
    generate(board, &mut moves, piece, true);

    for mv in moves.as_slice() {
        if !board.legal_lock_placement(mv) {
            continue;
        }

        let inputs = input_names_for_move(board, mv);
        let inputs = normalize_inputs_for_mode(&inputs, mv, SoftDropMode::GroundedSpinOnly);
        let Some(inputs) =
            supported_or_grounded_spin_fallback(board, inputs, mv, SoftDropMode::GroundedSpinOnly)
        else {
            continue;
        };

        let mut next_board = board.clone();
        let cleared = next_board.do_move(mv);
        let score = evaluate(&next_board, weights) + cleared as f32 * 0.25;

        if best
            .as_ref()
            .is_none_or(|(_, _, best_score, _)| score > *best_score)
        {
            *best = Some((*mv, hold_used, score, inputs));
        }
    }
}

fn any_input_fallback_move(
    state: &GameState,
    weights: &EvalWeights,
) -> Option<(Move, bool, f32, Vec<&'static str>)> {
    let mut best = None;
    consider_any_input_piece(&mut best, &state.board, state.current, false, weights);

    if let Some(held) = state.hold {
        consider_any_input_piece(&mut best, &state.board, held, true, weights);
    } else if let Some(&next) = state.queue.first() {
        consider_any_input_piece(&mut best, &state.board, next, true, weights);
    }

    best
}

fn main() {
    let cli = parse_cli_options(std::env::args().collect());
    let args = cli.args;
    let softdrop_mode = cli.softdrop_mode;

    if args.len() < 3 {
        print_json_error(
            "usage: quick_best <current_piece> <queue> [board] [hold] [--no-softdrop|--grounded-softdrop-spins] [--options-json <json>]",
        );
        return;
    }

    let current_char = args[1].chars().next().unwrap();

    let current = match parse_piece(current_char) {
        Some(p) => p,
        None => {
            print_json_error("invalid_current_piece");
            return;
        }
    };

    let queue: Vec<Piece> = args[2].chars().filter_map(parse_piece).collect();

    let board = if args.len() >= 4 {
        match board_from_visual(&args[3]) {
            Ok(b) => b,
            Err(e) => {
                println!(
                    "{{\"ok\":false,\"error\":\"board_parse_failed\",\"detail\":\"{}\"}}",
                    e
                );
                return;
            }
        }
    } else {
        Board::new()
    };

    let hold = if args.len() >= 5 {
        match args[4].chars().next().and_then(parse_piece) {
            Some(p) => Some(p),
            None => {
                print_json_error("invalid_hold_piece");
                return;
            }
        }
    } else {
        None
    };

    let mut state = GameState::new(board.clone(), current, queue);
    state.hold = hold;

    let weights = eval_weights_for_ai_profile();
    let config = match search_config_from_room_options(cli.room_options_json.as_deref()) {
        Ok(config) => config,
        Err(error) => {
            print_json_error(&error);
            return;
        }
    };

    match find_best_move_with_scores(&state, &config, &weights) {
        Some(result) => {
            let Some((best_move, hold_used, score, inputs)) =
                best_move_with_input_path(&state, &result, &weights, &config, softdrop_mode)
                    .or_else(|| any_input_fallback_move(&state, &weights))
            else {
                print_json_error("no_input_path");
                return;
            };

            let mut board_after = board.clone();
            let cleared = board_after.do_move(&best_move);
            let next_board = board_to_visual(&board_after);
            let inputs_json = inputs
                .iter()
                .map(|input| format!("\"{}\"", input))
                .collect::<Vec<_>>()
                .join(",");

            println!(
                "{{\"ok\":true,\"piece\":\"{:?}\",\"rotation\":\"{:?}\",\"x\":{},\"y\":{},\"spin\":\"{:?}\",\"hold_used\":{},\"score\":{},\"cleared\":{},\"inputs\":[{}],\"next_board\":\"{}\"}}",
                best_move.piece(),
                best_move.rotation(),
                best_move.x(),
                best_move.y(),
                best_move.spin(),
                hold_used,
                score,
                cleared,
                inputs_json,
                next_board
            );
        }
        None => {
            print_json_error("no_move_found");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grounded_spin_mode_allows_softdrop_then_rotation_spin() {
        let mv = Move::new_tspin(Rotation::North, 4, 1, true);
        let inputs = ["ShiftLeft", "SoftDrop", "RotateCw", "HardDrop"];

        assert_eq!(
            normalize_inputs_for_mode(&inputs, &mv, SoftDropMode::GroundedSpinOnly),
            vec!["ShiftLeft", "SoftDrop", "RotateCw", "HardDrop"]
        );
    }

    #[test]
    fn grounded_spin_mode_compresses_softdrop_spam() {
        let mv = Move::new_allspin_mini(Piece::S, Rotation::East, 6, 6);
        let inputs = [
            "ShiftRight",
            "SoftDrop",
            "SoftDrop",
            "SoftDrop",
            "RotateCw",
            "HardDrop",
        ];

        assert_eq!(
            normalize_inputs_for_mode(&inputs, &mv, SoftDropMode::GroundedSpinOnly),
            vec!["ShiftRight", "SoftDrop", "RotateCw", "HardDrop"]
        );
    }

    #[test]
    fn nospin_mode_replaces_pathfinder_rotation_loop_with_direct_inputs() {
        let mv = Move::new(Piece::L, Rotation::East, 7, 5, false);
        let inputs = [
            "RotateCw",
            "RotateCw",
            "RotateCcw",
            "RotateCcw",
            "RotateCw",
            "HardDrop",
        ];

        assert_eq!(
            normalize_inputs_for_mode(&inputs, &mv, SoftDropMode::GroundedSpinOnly),
            vec![
                "RotateCw",
                "ShiftRight",
                "ShiftRight",
                "ShiftRight",
                "HardDrop"
            ]
        );
    }

    #[test]
    fn nospin_direct_inputs_account_for_i_cw_spawn_kick() {
        let mv = Move::new(Piece::I, Rotation::East, 2, 2, false);

        assert_eq!(
            direct_inputs_for_nospin(&mv),
            vec![
                "RotateCw",
                "ShiftLeft",
                "ShiftLeft",
                "ShiftLeft",
                "HardDrop"
            ]
        );
    }

    #[test]
    fn nospin_direct_inputs_account_for_i_flip_spawn_kick() {
        let mv = Move::new(Piece::I, Rotation::South, 4, 2, false);

        assert_eq!(
            direct_inputs_for_nospin(&mv),
            vec!["RotateFlip", "ShiftLeft", "HardDrop"]
        );
    }

    #[test]
    fn grounded_spin_mode_converts_nonspin_softdrop_to_direct_drop() {
        let mv = Move::new(Piece::T, Rotation::North, 4, 1, false);
        let inputs = ["SoftDrop", "HardDrop"];

        assert_eq!(
            normalize_inputs_for_mode(&inputs, &mv, SoftDropMode::GroundedSpinOnly),
            vec!["HardDrop"]
        );
    }

    #[test]
    fn grounded_spin_mode_keeps_unusual_spin_path_without_softdrop_spam() {
        let mv = Move::new_tspin(Rotation::North, 4, 1, true);
        let inputs = ["SoftDrop", "SoftDrop", "ShiftRight", "RotateCw", "HardDrop"];

        assert_eq!(
            normalize_inputs_for_mode(&inputs, &mv, SoftDropMode::GroundedSpinOnly),
            vec!["SoftDrop", "ShiftRight", "RotateCw", "HardDrop"]
        );
    }

    #[test]
    fn grounded_spin_validator_rejects_midair_softdrop_path() {
        let board =
            board_from_visual(".....XXXX.|....XXXXXX|.....XXXXX|XX..XXXXXX|XX..XXXXXX|XXX.XXXXXX")
                .unwrap();
        let mv = Move::new_allspin_mini(Piece::S, Rotation::North, 3, 2);
        let inputs = ["ShiftLeft", "SoftDrop", "RotateCw", "RotateCcw", "HardDrop"];

        assert!(!input_sequence_supported(
            &board,
            &inputs,
            &mv,
            SoftDropMode::GroundedSpinOnly
        ));
    }

    #[test]
    fn grounded_nospin_fallback_finds_softdrop_tuck() {
        let board =
            board_from_visual("..........|........XX|X.......XX|XX......XX|XXXX.....X|XXXXX..XXX")
                .unwrap();
        let mv = Move::new(Piece::Z, Rotation::North, 7, 1, false);
        let direct = direct_inputs_for_nospin(&mv);

        assert!(!input_sequence_supported(
            &board,
            &direct,
            &mv,
            SoftDropMode::GroundedSpinOnly
        ));

        let fallback = grounded_nospin_fallback_inputs(&board, &mv).unwrap();
        assert_eq!(
            fallback,
            vec![
                "ShiftRight",
                "ShiftRight",
                "SoftDrop",
                "ShiftRight",
                "HardDrop"
            ]
        );
        assert!(grounded_inputs_match_target(&board, &fallback, &mv));
    }

    #[test]
    fn grounded_spin_fallback_prefers_wall_das_entry() {
        let board =
            board_from_visual("..........|..........|..XX......|...XX....X|..XX..XXXX|XXXXXXXX.X")
                .unwrap();
        let mv = Move::new_allspin_mini(Piece::S, Rotation::North, 1, 1);

        let fallback = grounded_spin_fallback_inputs(&board, &mv).unwrap();

        assert_eq!(
            fallback,
            vec![
                "RotateCw",
                "DasLeft",
                "SoftDrop",
                "RotateCw",
                "RotateCcw",
                "HardDrop"
            ]
        );
        assert!(grounded_inputs_match_target(&board, &fallback, &mv));
    }

    #[test]
    fn room_options_override_attack_config() {
        let json = r#"{
            "spinbonuses": "all-mini+",
            "combotable": "classic",
            "b2bcharging": false,
            "allclear_garbage": 3,
            "allclear_b2b": 1,
            "garbagemultiplier": 2.5
        }"#;

        let config = search_config_from_room_options(Some(json)).unwrap();

        assert_eq!(config.attack_config.pc_garbage, 3);
        assert_eq!(config.attack_config.pc_b2b, 1);
        assert!(!config.attack_config.b2b_chaining);
        assert_eq!(config.attack_config.combo_table, ComboTable::Classic);
        assert_eq!(config.attack_config.garbage_multiplier, 2.5);
    }

    #[test]
    fn stable_ai_profile_prioritizes_board_safety() {
        let config = search_config_from_room_options(None).unwrap();
        let weights = eval_weights_for_ai_profile();

        assert!(config.board_weight > SearchConfig::default().board_weight);
        assert!(config.attack_weight > SearchConfig::default().attack_weight);
        assert!(weights.holes < EvalWeights::default().holes);
        assert!(weights.height_upper_quarter < EvalWeights::default().height_upper_quarter);
        assert!(weights.tsd_overhang > 0.0);
    }

    #[test]
    fn spin_preference_rewards_clearing_spins() {
        let tspin_double = Move::new_tspin(Rotation::North, 4, 1, true);
        let allspin_double = Move::new_allspin_mini(Piece::S, Rotation::East, 4, 1);
        let nospin_double = Move::new(Piece::T, Rotation::North, 4, 1, false);

        assert!(spin_preference_bonus(&tspin_double, 2) > spin_preference_bonus(&nospin_double, 2));
        assert!(
            spin_preference_bonus(&allspin_double, 2) > spin_preference_bonus(&nospin_double, 2)
        );
        assert!(
            spin_preference_bonus(&tspin_double, 2) > spin_preference_bonus(&allspin_double, 2)
        );
    }
}
