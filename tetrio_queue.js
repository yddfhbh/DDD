function createTetrioPRNG(seed) {
  let t = parseInt(seed, 10) % 2147483647;
  if (t <= 0) t += 2147483646;

  return {
    next() {
      t = (16807 * t) % 2147483647;
      return t;
    },

    nextFloat() {
      return (this.next() - 1) / 2147483646;
    },

    shuffleArray(arr) {
      let j;
      let n = arr.length;

      if (n === 0) return arr;

      while (--n) {
        j = Math.floor(this.nextFloat() * (n + 1));
        [arr[n], arr[j]] = [arr[j], arr[n]];
      }

      return arr;
    },

    getCurrentSeed() {
      return t;
    },
  };
}

function generate7BagQueue(seed, count = 100) {
  const rng = createTetrioPRNG(seed);
  const minotypes = ["z", "l", "o", "s", "i", "j", "t"];

  const bag = [];
  const out = [];

  function populateBag() {
    const nextBag = [...minotypes];
    rng.shuffleArray(nextBag);
    bag.push(...nextBag);
  }

  while (out.length < count) {
    while (bag.length < 14) {
      populateBag();
    }

    out.push(bag.shift());
  }

  return out;
}

function getCurrentAndNext(seed, pieceIndex, nextCount = 6) {
  const queue = generate7BagQueue(seed, pieceIndex + nextCount + 1);
  const current = queue[pieceIndex];
  const next = queue.slice(pieceIndex + 1, pieceIndex + 1 + nextCount);

  return {
    current: current.toUpperCase(),
    queue: next.map(p => p.toUpperCase()).join(""),
    fullQueue: queue.map(p => p.toUpperCase()).join(""),
  };
}

module.exports = {
  createTetrioPRNG,
  generate7BagQueue,
  getCurrentAndNext,
};