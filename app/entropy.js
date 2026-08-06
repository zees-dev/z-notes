/* ============================================================
   entropy.js — the passphrase strength gate (research §5.4).

   This is the ONLY protection on the only long-lived secret in the system:
   `.znotes/identity.age` is committed and, per research §7.3, assumed readable
   by the adversary, so its safety is exactly scrypt(2^18) × passphrase
   entropy. A gate that scores "password password password" at 135 bits makes
   the entropy term fictional.

   The old estimate was `collapsedLength × log2(charsetPool)` with run
   collapsing applied per CHARACTER, which cannot see a repeated word, a
   dictionary word or a keyboard walk. This one is word-aware and takes the
   MINIMUM of the two views, so it is never more optimistic than the crude
   charset bound it replaces.

   Deliberately conservative: under-counting a strong passphrase costs the user
   one more word, over-counting a weak one costs them the vault.
   ============================================================ */
"use strict";

/* A short embedded list beats a diceware file we would have to ship and keep:
   log2(list) bits per word, enough words to clear 80. */
export const WORDS = (
  "able acid acre aged airy also amber amend angle ankle apple april arbor arena argue arrow aside atlas audio " +
  "aunt avoid awake bacon badge baker balmy banjo barge basil basin batch beach beard began begin below bench " +
  "berry birch birth blade blend bliss bloom blunt board bonus boost booth brace braid brand brass brave bread " +
  "brick brief brine bring brisk broad brook brush buddy build bunch cabin cable cameo canal candy canoe canvas " +
  "cargo carol carve cedar chalk charm chase cheer chess chief chime churn cider cinema civic claim clamp clash " +
  "clean clear cliff climb cloak clock cloud clove coast cobra cocoa comet coral couch cover crane crate crawl " +
  "cream creek crest crisp crown crumb curve cycle daily dance dandy dealt debut decay delta dense depth diary " +
  "diner ditch diver dizzy dodge donor doubt draft drain drape dream dress drift drill drink drove drums eager " +
  "eagle early earth easel ebony edge eight elbow elder elite ember empty enact enjoy entry equal essay ether " +
  "event exact exist extra fable fancy feast fence ferry fetch fever fiber field fifth fifty final finch first " +
  "flame flash fleet flint float flock flood flour fluid flute focal foggy force forge forty found frame fresh " +
  "frost fruit fudge gable gauge ghost giant glade glass glaze globe glory glove going grace grade grain grand " +
  "grape grasp grass grave green greet grill grove guard guest guide gully habit handy happy hardy haste hatch " +
  "haven hazel heart heavy hedge hefty hello hence herbs hinge hobby honey horse hotel hound house hover human " +
  "humid hurry ideal image inbox index inlet inner input irony ivory jelly jewel joint jolly judge juice jumbo " +
  "keen kernel kite knack kneel knife knock koala label labor lance large latch later laugh layer leaf learn " +
  "ledge lemon level lever light lilac limit linen linger lively llama lobby local lodge logic loyal lucid lunar " +
  "lunch lyric magic major maker mango maple march marsh match maybe meadow medal melon mercy merge merit metal " +
  "meter midst might mimic miner minor mirth mixer model moist money month moral motor mound mount mouse mover " +
  "movie music nacho nasal navy nectar needle nerve never newer niche night noble noise north notch novel nudge " +
  "nurse oasis ocean offer olive omega onion opera orbit order organ otter ought ounce outer owner ozone paint " +
  "panel paper parka party paste patch pause peace pearl pedal penny perch petal photo piano piece pilot pinch " +
  "pitch pivot pixel plain plank plant plaza plead plume plush poem point polar porch pouch pound power prairie " +
  "press prime print prism prize probe proof proud prune pulse punch pupil purse quake quart queen query quest " +
  "quick quiet quilt quirk quota radar radio raise rally ranch range rapid raven reach realm rebel refer relax " +
  "relay remix renew reply rhyme ridge rifle rigid rinse ripen risky rival river roast robin robot rocky rogue " +
  "roman rooster rotor rough round route royal rugby ruler rumor rural rustic saddle safer saint salad salon " +
  "salsa sandy sauce scale scarf scene scent scope score scout scrap sedan sepia serve seven shade shaft shale " +
  "shape share sharp shelf shell shift shine shirt shore short shrub siege sight silky since siren sixth sketch " +
  "skill slate sleek slice slide slope small smart smile smoke snack snake sneak solar solid sonic sound south " +
  "space spade spark speak spear spice spike spine spiral spoke spoon sport spray sprig squad stack staff stage " +
  "stair stamp stand stark steam steel steep stern stick still stock stone stool store storm stove strap straw " +
  "strip study sugar suite sunny super surge swamp swarm sweep sweet swift swing sword table tacit talon tango " +
  "tapir tempo tenor tepid thank theme thick thing thorn three throw thumb tidal tiger timer title toast today " +
  "token tonic torch total tower trace track trade trail train tramp treat trend trial tribe trout truce truly " +
  "trunk trust truth tulip tunic turbo tutor twine twist ultra uncle under union unite unity until upper urban " +
  "usage usher utter vague valid value vapor vault venue verse video vigor villa vinyl viola vireo virtue vista " +
  "vivid vocal vodka vogue voice voter wafer wager wagon waltz waste watch water waver weave wedge whale wheat " +
  "wheel where which while whisk white whole widen width windy wiser witty woven wrist write yacht yeast yield " +
  "young youth zebra zesty zonal"
).split(/\s+/);

export const WORD_BITS = Math.log2(WORDS.length);

export function generatePassphrase() {
  const n = Math.ceil(80 / WORD_BITS);
  const out = [];
  while (out.length < n) {
    /* rejection sampling: `% length` on a 32-bit draw is biased, and this is
       the one place in the app where bias is a security bug */
    const limit = Math.floor(0x100000000 / WORDS.length) * WORDS.length;
    let v;
    const buf = new Uint32Array(1);
    do {
      crypto.getRandomValues(buf);
      v = buf[0];
    } while (v >= limit);
    const word = WORDS[v % WORDS.length];
    /* DISTINCT words: a repeat is one guess plus a repeat count, which is
       exactly how estimateBits counts it — so drawing one would quietly lower
       the strength of the phrase the modal is telling the user to trust.
       Sampling without replacement costs log2(707!/(707-9)!) ≈ 85 bits, a
       fraction of a bit under the with-replacement value. */
    if (out.includes(word)) continue;
    out.push(word);
  }
  return out.join(" ");
}

/* ------------------------------------------------------------------
   the estimate
   ------------------------------------------------------------------ */

/* Top-of-every-list passwords. A token here is worth almost nothing no matter
   how long it is — "password" is one guess, not eight characters. */
const COMMON = new Set([
  "password", "passwd", "pass", "letmein", "welcome", "admin", "administrator", "secret",
  "qwerty", "hunter", "dragon", "monkey", "login", "iloveyou", "sunshine", "princess",
  "football", "baseball", "master", "shadow", "trustno", "starwars", "changeme", "default",
  "abc", "test", "guest", "root", "znotes",
]);

/* Keyboard walks and alphabet/digit runs: a long substring of one of these is
   a handful of guesses, not one guess per character. */
const RUNS = [
  "qwertyuiopasdfghjklzxcvbnm",
  "azertyuiopqsdfghjklmwxcvbn",
  "1234567890",
  "abcdefghijklmnopqrstuvwxyz",
  "!@#$%^&*()",
];

/* log2 of a plausible attack dictionary (~130k words). Any token that looks
   like a single word cannot be worth more than one dictionary pick, however
   many characters it happens to have. Length-capped because a genuinely random
   14+ character lowercase string is not a dictionary word. */
const DICT_BITS = 17;
const DICT_MAX_LEN = 14;
const RUN_BITS = 6;
const COMMON_BITS = 4;

const WORD_SET = new Set(WORDS);

function poolOf(s) {
  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/[0-9]/.test(s)) pool += 10;
  if (/[^A-Za-z0-9]/.test(s)) pool += 33;
  return Math.max(2, pool);
}

/* Runs of one character count once ("aaaaaaaaaaaa" is not 12 characters of
   entropy) and so does a repeated substring ("hunter2hunter2" is one guess
   plus a repeat count, not two). */
function collapse(s) {
  return s.replace(/(.)\1+/g, "$1").replace(/(.{2,}?)\1+/g, "$1");
}

/** The old, purely character-class estimate — kept as the upper bound. */
export function charsetBits(s) {
  if (!s) return 0;
  return collapse(s).length * Math.log2(poolOf(s));
}

function isRun(low) {
  if (low.length < 4) return false;
  const rev = [...low].reverse().join("");
  return RUNS.some((r) => r.includes(low) || r.includes(rev));
}

/** Bits for ONE whitespace-delimited token, capped by every view that applies. */
function tokenBits(tok) {
  const low = tok.toLowerCase();
  /* every test below runs against the collapsed form too: "hunter2hunter2" is
     "hunter2" said twice, and it must not escape the checks "hunter2" fails */
  const forms = new Set([low, collapse(low)]);
  let bits = charsetBits(tok);
  for (const f of forms) {
    const letters = f.replace(/[^a-z]/g, "");
    const alnum = f.replace(/[^a-z0-9]/g, "");
    /* a word from our own generator is worth exactly one draw from our own list */
    if (WORD_SET.has(f)) bits = Math.min(bits, WORD_BITS);
    /* letters-only (separators are free) and short enough to be a real word */
    if (letters.length >= 4 && letters.length === alnum.length && letters.length <= DICT_MAX_LEN)
      bits = Math.min(bits, DICT_BITS);
    if (isRun(f)) bits = Math.min(bits, RUN_BITS);
    if (COMMON.has(letters) || COMMON.has(f)) bits = Math.min(bits, COMMON_BITS);
  }
  return bits;
}

/**
 * Estimated bits of entropy. Word-aware, duplicate-blind and never above the
 * crude charset bound.
 *
 * Repeated tokens contribute ONCE: "password password password" is one guess
 * and a repeat count, which is why the old estimate's 135 was off by ~7×.
 */
export function estimateBits(s) {
  if (!s) return 0;
  const str = String(s);
  const tokens = str.trim().split(/\s+/).filter(Boolean);
  const seen = new Set();
  let sum = 0;
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    sum += tokenBits(t);
  }
  return Math.max(0, Math.round(Math.min(sum, charsetBits(str))));
}

/** The floor the create-identity modal enforces (research §5.4). */
export const MIN_BITS = 60;
