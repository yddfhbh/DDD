function PRNG(seed) {
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

function generate7BagQueue(seed, count = 50, minotypesText = "zlosijt") {
  const rng = PRNG(seed);
  const minotypes = minotypesText.toLowerCase().split("");

  const bag = [];
  const out = [];

  function populateBag() {
    const nextBag = [...minotypes];
    rng.shuffleArray(nextBag);
    bag.push(...nextBag);
  }

  while (out.length < count) {
    // TETR.IO PullFromBag 쪽이 일반 모드에서 bag.length < 14면 PopulateBag 반복
    while (bag.length < 14) {
      populateBag();
    }

    out.push(bag.shift());
  }

  return out;
}

const seed = process.argv[2] ?? "1234019309";
const count = Number(process.argv[3] ?? 50);
const minotypesText = process.argv[4] ?? "zlosijt";

const queue = generate7BagQueue(seed, count, minotypesText);

console.log("seed:", seed);
console.log("minotypes:", minotypesText);
console.log("queue:", queue.join("").toUpperCase());
console.log(queue);