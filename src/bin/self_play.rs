use direct_cobra_copy::board::Board;
use direct_cobra_copy::eval::EvalWeights;
use direct_cobra_copy::header::Piece;
use direct_cobra_copy::search::{find_best_move, SearchConfig};
use direct_cobra_copy::state::GameState;

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

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let queue_text = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "TIOLJSZTIOLJSZTIOLJSZTIOLJSZTIOLJSZTIOLJSZ".to_string());

    let pieces: Vec<Piece> = queue_text.chars().filter_map(parse_piece).collect();

    if pieces.len() < 2 {
        eprintln!("큐가 너무 짧음. 예: cargo run --release --bin self_play -- TIOLJSZTIOLJSZ");
        return;
    }

    let mut board = Board::new();

    let weights = EvalWeights::default();

    let config = SearchConfig {
        time_budget_ms: Some(50),
        ..SearchConfig::default()
    };

    let max_turns = pieces.len() - 1;

    for turn in 0..max_turns {
        let current = pieces[turn];

        // 현재 블럭 다음부터 lookahead 큐로 넘김
        let queue: Vec<Piece> = pieces.iter().skip(turn + 1).take(6).copied().collect();

        let state = GameState::new(board.clone(), current, queue);

        let result = match find_best_move(&state, &config, &weights) {
            Some(r) => r,
            None => {
                println!("turn {}: no move found", turn);
                break;
            }
        };

        let m = result.best_move;

        println!(
            "turn {:02} current={:?} -> piece={:?} rot={:?} x={} y={} spin={:?} hold={} score={}",
            turn,
            current,
            m.piece(),
            m.rotation(),
            m.x(),
            m.y(),
            m.spin(),
            result.hold_used,
            result.score
        );
        let cleared = board.do_move(&m);

        println!(
            "turn {:02} current={:?} -> piece={:?} rot={:?} x={} y={} hold={} score={} cleared={} height={}",
        turn,
        current,
        m.piece(),
        m.rotation(),
        m.x(),
        m.y(),
        result.hold_used,
        result.score,
        cleared,
        board.height()
    );

        if board.height() >= 20 {
            println!("topout-ish: board height {}", board.height());
            break;
        }
    }
}
