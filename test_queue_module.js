const { getCurrentAndNext, generate7BagQueue } = require("./tetrio_queue");

const seed = process.argv[2] ?? "1234019309";
const pieceIndex = Number(process.argv[3] ?? 0);

console.log("full:", generate7BagQueue(seed, 50).map(p => p.toUpperCase()).join(""));

console.log(getCurrentAndNext(seed, pieceIndex, 6));