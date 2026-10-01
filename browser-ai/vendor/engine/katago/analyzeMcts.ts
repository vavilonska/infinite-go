import { historyFeaturesV7 } from './historyV7';
import * as tf from '@tensorflow/tfjs';
import type { BoardState, FloatArray, GameRules, Move, Player, RegionOfInterest } from '../../types';
import { getAnimationNow } from '../../utils/animationFrame';
import { formatGtpMove } from '../../lib/gtp';
import { postprocessKataGoV8 } from './evalV8';
import type { KataGoModelV8Tf } from './modelV8';
import {
  expectedWhiteScoreValue,
  getScoreStdev,
  getSqrtBoardArea,
  whiteDScoreValueDScoreSmoothNoDrawAdjust,
} from './scoreValue';
import { ENGINE_MAX_TIME_MS, ENGINE_MAX_VISITS } from './limits';
import { interpolateEarly } from './chosenMove';
import {
  BLACK,
  WHITE,
  EMPTY,
  BOARD_AREA,
  BOARD_SIZE,
  PASS_MOVE,
  NEIGHBOR_COUNTS,
  NEIGHBOR_LIST,
  NEIGHBOR_STARTS,
  opponentOf,
  playMove,
  undoMove,
  computeLadderFeaturesV7KataGoInto,
  computeLadderedStonesV7KataGoInto,
  computeAreaMapV7KataGoInto,
  computePassAliveAreaInto,
  isAdjacentToColor,
  isNonPassAliveSelfConnection,
  wouldBeCapture,
  computeIndependentLifeAreaInto,
  computeLibertyMap,
  computeLibertyMapInto,
  updateLibertyMapForSeeds,
  type SimPosition,
  type StoneColor,
  type UndoSnapshot,
} from './fastBoard';
import {
  GRAPH_SEARCH_REP_BOUND,
  computeStateHash,
  mixGraphHash,
  packHashKey,
  simpleRepetitionBoundGt,
} from './graphHash';
import { fillInputsV7Fast, type RecentMove } from './featuresV7Fast';
import { areaFeatureModeForRules, groupTaxPerRegion, isAreaScoring, isSuicideLegal, rulesOf } from '../../utils/goRules';
import { POLICY_OPTIMISM, ROOT_POLICY_OPTIMISM } from './searchParams';

import { createSuperkoHistory, type SuperkoHistory } from './superkoHistory';

export type OwnershipMode = 'none' | 'root' | 'tree';

type PolicyValueOutput = ReturnType<KataGoModelV8Tf['forwardPolicyValue']>;
type PolicyValueOwnershipOutput = ReturnType<KataGoModelV8Tf['forward']>;

const hasOwnership = (out: PolicyValueOutput | PolicyValueOwnershipOutput): out is PolicyValueOwnershipOutput => {
  return 'ownership' in out;
};

type Edge = {
  move: number; // 0..360 or PASS_MOVE
  prior: number;
  child: Node | null;
  /**
   * KataGo's edge visits, which lag the child's own visit count whenever a
   * weightless playout evaluated the child without the parent paying for it.
   * The parent only owns the fraction of the child's weight its edge visits bought.
   */
  visits: number;
  pvCache?: { visits: number; depth: number; moves: number[]; pvVisits: number[]; pvEdgeVisits: number[] };
};

/** KataGo NodeStats::childWeight (cpp/search/searchnode.h). */
function edgeChildWeight(edge: Edge): number {
  const child = edge.child;
  if (!child) return 0;
  const childVisits = child.visits;
  if (childVisits <= 0 || edge.visits <= 0) return 0;
  if (edge.visits >= childVisits) return child.weightSum;
  return (child.weightSum * edge.visits) / childVisits;
}

/** KataGo NodeStats::childWeightSq. */
function edgeChildWeightSq(edge: Edge): number {
  const child = edge.child;
  if (!child) return 0;
  const childVisits = child.visits;
  if (childVisits <= 0 || edge.visits <= 0) return 0;
  if (edge.visits >= childVisits) return child.weightSqSum;
  return (child.weightSqSum * edge.visits) / childVisits;
}

type ExpandScratch = {
  moves: Int16Array;
  logits: Float32Array;
  priors: Float64Array;
  topMoves: Int16Array;
  topPriors: Float64Array;
  order: number[];
};

let expandScratch: ExpandScratch | null = null;
let expandScratchBoardArea = 0;
const getExpandScratch = (): ExpandScratch => {
  if (!expandScratch || expandScratchBoardArea !== BOARD_AREA) {
    expandScratch = {
      moves: new Int16Array(BOARD_AREA),
      logits: new Float32Array(BOARD_AREA),
      priors: new Float64Array(BOARD_AREA),
      topMoves: new Int16Array(BOARD_AREA),
      topPriors: new Float64Array(BOARD_AREA),
      order: [],
    };
    expandScratchBoardArea = BOARD_AREA;
  }
  return expandScratch;
};

/**
 * A search node, holding KataGo's NodeStats: weighted averages over this node's own
 * network evaluation and its children's stats, recomputed after every playout
 * (cpp/search/searchupdatehelpers.cpp recomputeNodeStats) rather than accumulated,
 * because the children are reweighted every time.
 */
class Node {
  readonly playerToMove: StoneColor;
  visits = 0;
  weightSum = 0;
  weightSqSum = 0;
  valueAvg = 0; // [-1,1] where +1 is black win
  noResultAvg = 0; // probability this subtree ends with no result at all
  scoreLeadAvg = 0; // black lead
  scoreMeanAvg = 0; // black score mean
  scoreMeanSqAvg = 0; // E[score^2], for the mixture stdev
  utilityAvg = 0; // from black perspective
  utilitySqAvg = 0; // from black perspective

  // This node's own network evaluation, which is one weighted term of the above.
  nnValue = 0;
  nnNoResult = 0;
  nnScoreLead = 0;
  nnScoreMean = 0;
  nnScoreMeanSq = 0;
  nnWeight = 1;
  nnUtility: number | null = null; // direct NN eval utility, from black perspective

  /** Set when the game is over here: the score is known, so no network eval is needed. */
  isTerminal = false;

  // Subtree value bias: the shared record of how much the search has historically
  // disagreed with the network about positions that look locally like this one.
  biasEntry: SubtreeBiasEntry | null = null;
  biasEpoch = -1;
  lastBiasDeltaSum = 0;
  lastBiasWeight = 0;
  ownership: Float32Array | null = null; // len 361, +1 black owns, -1 white owns
  inFlight = 0;
  pendingEval = false;
  edges: Edge[] | null = null;

  constructor(playerToMove: StoneColor) {
    this.playerToMove = playerToMove;
  }
}

function playerToColor(p: Player): StoneColor {
  return p === 'black' ? BLACK : WHITE;
}

function colorToPlayer(c: StoneColor): Player {
  return c === BLACK ? 'black' : 'white';
}

function boardStateToStones(board: BoardState): Uint8Array<ArrayBuffer> {
  const stones = new Uint8Array(BOARD_AREA);
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      const v = board[y]?.[x] ?? null;
      if (!v) continue;
      stones[y * BOARD_SIZE + x] = v === 'black' ? BLACK : WHITE;
    }
  }
  return stones;
}

function computeKoPointFromPrevious(args: { board: BoardState; previousBoard?: BoardState; moveHistory: Move[]; rules: GameRules }): number {
  const { previousBoard, moveHistory } = args;
  if (!previousBoard) return -1;
  const last = moveHistory.length > 0 ? moveHistory[moveHistory.length - 1] : null;
  if (!last || last.x < 0 || last.y < 0) return -1;

  const prevStones = boardStateToStones(previousBoard);
  const pos: SimPosition = { stones: prevStones, koPoint: -1 };
  const captureStack: number[] = [];
  playMove(pos, last.y * BOARD_SIZE + last.x, playerToColor(last.player), captureStack, isSuicideLegal(args.rules));
  return pos.koPoint;
}

function computeKoPointAfterMove(previousBoard: BoardState | undefined, move: Move | null, rules: GameRules): number {
  if (!previousBoard || !move || move.x < 0 || move.y < 0) return -1;
  const prevStones = boardStateToStones(previousBoard);
  const pos: SimPosition = { stones: prevStones, koPoint: -1 };
  const captureStack: number[] = [];
  playMove(pos, move.y * BOARD_SIZE + move.x, playerToColor(move.player), captureStack, isSuicideLegal(rules));
  return pos.koPoint;
}

function takeRecentMoves(
  rootMoves: RecentMove[],
  pathMoves: RecentMove[],
  max: number,
  out: RecentMove[] = []
): RecentMove[] {
  out.length = 0;
  const pushCopy = (src: RecentMove) => {
    const idx = out.length;
    let dst = out[idx];
    if (!dst) {
      dst = { move: src.move, player: src.player };
      out[idx] = dst;
    } else {
      dst.move = src.move;
      dst.player = src.player;
    }
    out.length = idx + 1;
  };
  for (let i = pathMoves.length - 1; i >= 0 && out.length < max; i--) pushCopy(pathMoves[i]!);
  for (let i = rootMoves.length - 1; i >= 0 && out.length < max; i--) pushCopy(rootMoves[i]!);
  out.reverse();
  return out;
}

function normalizeRegionOfInterest(roi?: RegionOfInterest | null): RegionOfInterest | null {
  if (!roi) return null;
  const xMin = Math.max(0, Math.min(BOARD_SIZE - 1, Math.min(roi.xMin, roi.xMax)));
  const xMax = Math.max(0, Math.min(BOARD_SIZE - 1, Math.max(roi.xMin, roi.xMax)));
  const yMin = Math.max(0, Math.min(BOARD_SIZE - 1, Math.min(roi.yMin, roi.yMax)));
  const yMax = Math.max(0, Math.min(BOARD_SIZE - 1, Math.max(roi.yMin, roi.yMax)));
  const isSinglePoint = xMin === xMax && yMin === yMax;
  const isWholeBoard = xMin === 0 && yMin === 0 && xMax === BOARD_SIZE - 1 && yMax === BOARD_SIZE - 1;
  if (isSinglePoint || isWholeBoard) return null;
  return { xMin, xMax, yMin, yMax };
}

function buildAllowedMovesMask(roi?: RegionOfInterest | null): Uint8Array | null {
  const normalized = normalizeRegionOfInterest(roi);
  if (!normalized) return null;
  const allowed = new Uint8Array(BOARD_AREA);
  for (let y = normalized.yMin; y <= normalized.yMax; y++) {
    const rowOff = y * BOARD_SIZE;
    for (let x = normalized.xMin; x <= normalized.xMax; x++) {
      allowed[rowOff + x] = 1;
    }
  }
  return allowed;
}

/** Last n entries of a move list, oldest first. */
/** How many passes the game currently ends with, KataGo's consecutiveEndingPasses. */
function countConsecutiveEndingPasses(moves: RecentMove[]): number {
  let count = 0;
  for (let i = moves.length - 1; i >= 0; i--) {
    if (moves[i]!.move !== PASS_MOVE) break;
    count++;
  }
  return count;
}

function takeLastMoves(moves: RecentMove[], n: number): RecentMove[] {
  return moves.length <= n ? moves : moves.slice(moves.length - n);
}

/**
 * KataGo's four-passes test in isAllowedRootMove: the opponent's last four moves
 * (every other entry back from the end) were all passes.
 */
function opponentHasPassedFourTimes(moveHistory: RecentMove[], currentPlayer: Player): boolean {
  const lastIdx = moveHistory.length - 1;
  if (lastIdx < 6) return false;
  const opp: Player = currentPlayer === 'black' ? 'white' : 'black';
  for (const back of [0, 2, 4, 6]) {
    const m = moveHistory[lastIdx - back]!;
    if (m.move !== PASS_MOVE || m.player !== opp) return false;
  }
  return true;
}

/**
 * Symmetries under which the root position is unchanged, KataGo's
 * SymmetryHelpers::markDuplicateMoveLocs (cpp/neuralnet/nninputs.cpp).
 *
 * KataGo compares stones only, which is sound because its analysis engine zeroes
 * the pre-root history. When this port is asked to keep that history instead, a
 * symmetry that moves one of the last five moves changes the network input and is
 * not a real duplicate, so it has to fix those moves too.
 */
export function computeValidRootSymmetries(args: {
  stones: Uint8Array;
  koPoint: number;
  recentMoves: RecentMove[];
  ignorePreRootHistory?: boolean;
}): number[] {
  const valid = [0];
  // A ko ban is not symmetric, so nothing may be treated as a duplicate.
  if (args.koPoint >= 0) return valid;

  const map = getSymPosMap();
  for (let sym = 1; sym < NUM_SYMMETRIES; sym++) {
    const off = sym * BOARD_AREA;
    let ok = true;
    for (let p = 0; p < BOARD_AREA; p++) {
      if (args.stones[p] !== args.stones[map[off + p]!]) {
        ok = false;
        break;
      }
    }
    if (ok && args.ignorePreRootHistory !== true) {
      for (const m of args.recentMoves) {
        if (m.move === PASS_MOVE) continue;
        if (map[off + m.move] !== m.move) {
          ok = false;
          break;
        }
      }
    }
    if (ok) valid.push(sym);
  }
  return valid;
}

/**
 * Marks every root move that is a symmetric copy of another, keeping one
 * representative. The iteration order is KataGo's, which keeps the representative
 * in the upper right for black:
 * https://senseis.xmp.net/?PlayingTheFirstMoveInTheUpperRightCorner
 */
export function markSymmetryDuplicateMoves(
  validSymmetries: number[],
  nextPlayerIsBlack: boolean,
  roiMask: Uint8Array | null
): Uint8Array | null {
  if (validSymmetries.length <= 1) return null;
  const map = getSymPosMap();
  const dup = new Uint8Array(BOARD_AREA);
  const n = BOARD_SIZE;

  const markFrom = (loc: number) => {
    // A move the search may not play never becomes the representative, so a copy
    // inside the region survives instead (KataGo passes avoidMoveUntilByLoc here).
    if (roiMask && roiMask[loc] === 0) return;
    if (dup[loc] === 1) return;
    for (const sym of validSymmetries) {
      if (sym === 0) continue;
      const symLoc = map[sym * BOARD_AREA + loc]!;
      if (symLoc !== loc) dup[symLoc] = 1;
    }
  };

  if (nextPlayerIsBlack) {
    for (let x = n - 1; x >= 0; x--) {
      for (let y = 0; y < n; y++) markFrom(y * n + x);
    }
  } else {
    for (let x = 0; x < n; x++) {
      for (let y = n - 1; y >= 0; y--) markFrom(y * n + x);
    }
  }
  return dup;
}

/**
 * The root move mask: the region of interest, minus symmetric duplicates when
 * root symmetry pruning applies. Also reports the symmetries that were folded
 * away so the analysis output can put the copies back.
 */
/**
 * The moves a human of the configured rank is most likely to play, as a mask.
 * They are added to the root's children so the report says what those moves are
 * actually worth, which is the point of loading the human net at all.
 */
export function topHumanMovesMask(humanPolicy: ArrayLike<number> | null | undefined, count: number): Uint8Array | null {
  if (!humanPolicy || count <= 0) return null;
  const best: Array<{ move: number; prob: number }> = [];
  for (let p = 0; p < BOARD_AREA; p++) {
    const prob = humanPolicy[p] ?? -1;
    if (prob <= 0) continue;
    if (best.length < count) {
      best.push({ move: p, prob });
      if (best.length === count) best.sort((a, b) => a.prob - b.prob);
    } else if (prob > best[0]!.prob) {
      best[0] = { move: p, prob };
      best.sort((a, b) => a.prob - b.prob);
    }
  }
  if (best.length === 0) return null;
  const mask = new Uint8Array(BOARD_AREA);
  for (const entry of best) mask[entry.move] = 1;
  return mask;
}

function buildRootMoveMask(args: {
  regionOfInterest?: RegionOfInterest | null;
  stones: Uint8Array;
  koPoint: number;
  moveHistory: RecentMove[];
  currentPlayer: Player;
  multiStoneSuicideLegal: boolean;
  symmetryPruning?: boolean;
  superkoHistory?: SuperkoHistory | null;
  /** KataGo ignorePreRootHistory: with it on, symmetry is a matter of stones alone. */
  ignorePreRootHistory?: boolean;
  /**
   * KataGo avoidMoveUntilByLoc for the player to move: the ply before which each
   * move is off limits. Index BOARD_AREA is the pass. Zero means no restriction.
   */
  avoidMoveUntil?: Int32Array | null;
}): { allowedMoves: Uint8Array | null; roiMask: Uint8Array | null; rootSymmetries: number[] } {
  const roiMask = buildAllowedMovesMask(args.regionOfInterest);
  let allowedMoves = roiMask;

  if (args.avoidMoveUntil) {
    // The root is ply zero, so anything with a positive untilDepth is banned here.
    const avoided = allowedMoves ? new Uint8Array(allowedMoves) : new Uint8Array(BOARD_AREA).fill(1);
    for (let p = 0; p < BOARD_AREA; p++) {
      if (args.avoidMoveUntil[p]! > 0) avoided[p] = 0;
    }
    allowedMoves = avoided;
  }

  // KataGo rootPruneUselessMoves: once the opponent has passed four times running,
  // stop considering moves inside either side's pass-alive area. Those only prolong
  // a finished game (cpp/search/searchhelpers.cpp isAllowedRootMove).
  if (opponentHasPassedFourTimes(args.moveHistory, args.currentPlayer)) {
    const safeArea = computePassAliveAreaInto(args.stones, new Uint8Array(BOARD_AREA), args.multiStoneSuicideLegal);
    const pruned = allowedMoves ? new Uint8Array(allowedMoves) : new Uint8Array(BOARD_AREA).fill(1);
    for (let p = 0; p < BOARD_AREA; p++) {
      if ((safeArea[p] as StoneColor) !== EMPTY) pruned[p] = 0;
    }
    // Passing is never masked, so pruning every point on the board is still fine.
    allowedMoves = pruned;
  }

  if (args.symmetryPruning === false) return { allowedMoves, roiMask, rootSymmetries: [0] };

  const rootSymmetries = computeValidRootSymmetries({
    stones: args.stones,
    koPoint: args.koPoint,
    recentMoves: takeLastMoves(args.moveHistory, 5),
    ignorePreRootHistory: args.ignorePreRootHistory,
  });
  const historySymmetries = args.superkoHistory
    ? rootSymmetries.filter(sym => args.superkoHistory!.isSymmetryInvariant(getSymPosMap().subarray(sym * BOARD_AREA, (sym + 1) * BOARD_AREA)))
    : rootSymmetries;
  rootSymmetries.splice(0, rootSymmetries.length, ...historySymmetries);
  const symDupMoves = markSymmetryDuplicateMoves(rootSymmetries, args.currentPlayer === 'black', allowedMoves);
  if (!symDupMoves) return { allowedMoves, roiMask, rootSymmetries };

  // Searching one copy of each symmetric move spends every visit on a distinct
  // position; the copies go back into the analysis output afterwards.
  const allowed = allowedMoves ? new Uint8Array(allowedMoves) : new Uint8Array(BOARD_AREA).fill(1);
  for (let p = 0; p < BOARD_AREA; p++) {
    if (symDupMoves[p] === 1) allowed[p] = 0;
  }
  return { allowedMoves: allowed, roiMask, rootSymmetries };
}

function expandNode(args: {
  node: Node;
  stones: Uint8Array;
  koPoint: number;
  multiStoneSuicideLegal: boolean;
  superkoBanned?: Uint8Array;
  policyLogits: ArrayLike<number>; // len 361 (in symmetry space if policyLogitsSymmetry != 0)
  policyLogitsSymmetry?: number; // 0..7, where 0 is identity
  passLogit: number;
  maxChildren: number;
  libertyMap?: Uint8Array;
  allowedMoves?: Uint8Array;
  /** Moves to keep as children even if the policy would rank them out of the top set. */
  forcedMoves?: Uint8Array;
  policyOut?: Float32Array; // len 362, illegal = -1, pass at index 361
  policyOutputScaling?: number;
  /**
   * KataGo rootPolicyTemperature, already interpolated for the turn number. Above 1
   * it flattens the root policy so the search spreads over more moves. It reshapes
   * the priors the search explores by, never the policy that gets reported.
   */
  rootPolicyTemperature?: number;
}): void {
  const { node, stones, koPoint, policyLogits, passLogit, maxChildren } = args;
  const policyScale = args.policyOutputScaling ?? 1.0;
  const pla = node.playerToMove;
  const opp = opponentOf(pla);
  const sym = args.policyLogitsSymmetry ?? 0;
  const symOff = sym * BOARD_AREA;
  const symPosMap = sym === 0 ? null : getSymPosMap();

  const libs = args.libertyMap ?? computeLibertyMap(stones);

  const scratch = getExpandScratch();
  const movesScratch = scratch.moves;
  const logitsScratch = scratch.logits;
  const priorsScratch = scratch.priors;
  let moveCount = 0;
  const passLogitScaled = passLogit * policyScale;
  let maxLogit = passLogitScaled;
  const allowedMoves = args.allowedMoves;
  for (let p = 0; p < BOARD_AREA; p++) {
    if (stones[p] !== EMPTY) continue;
    if (p === koPoint || args.superkoBanned?.[p]) continue;

    let hasEmptyNeighbor = false;
    let captures = false;
    let connectsLegally = false;

    const nStart = NEIGHBOR_STARTS[p]!;
    const nCount = NEIGHBOR_COUNTS[p]!;

    for (let i = 0; i < nCount; i++) {
      const n = NEIGHBOR_LIST[nStart + i]!;
      const c = stones[n] as StoneColor;
      if (c === EMPTY) {
        hasEmptyNeighbor = true;
        break;
      }
      if (c === opp) {
        if (libs[n] === 1) {
          captures = true;
          break;
        }
        continue;
      }
      if (c === pla && (libs[n] > 1 || args.multiStoneSuicideLegal)) {
        connectsLegally = true;
        break;
      }
    }

    if (!hasEmptyNeighbor && !captures && !connectsLegally) continue;
    const symPos = sym === 0 ? p : symPosMap![symOff + p]!;
    const logit = policyLogits[symPos]! * policyScale;
    movesScratch[moveCount] = p;
    logitsScratch[moveCount] = logit;
    if (logit > maxLogit) maxLogit = logit;
    moveCount++;
  }

  let sum = 0;
  for (let i = 0; i < moveCount; i++) {
    const v = Math.exp(logitsScratch[i]! - maxLogit);
    priorsScratch[i] = v;
    sum += v;
  }
  const passPriorRaw = Math.exp(passLogitScaled - maxLogit);
  sum += passPriorRaw;
  const invSum = 1.0 / sum;
  for (let i = 0; i < moveCount; i++) priorsScratch[i] *= invSum;
  let passPrior = passPriorRaw * invSum;

  if (args.policyOut) {
    const out = args.policyOut;
    out.fill(-1);
    for (let i = 0; i < moveCount; i++) out[movesScratch[i]!] = priorsScratch[i]! as number;
    out[PASS_MOVE] = passPrior as number;
  }

  // KataGo Search::maybeAddPolicyNoiseAndTemp. The reported policy above is the raw
  // one; only what the search explores by is reshaped.
  const rootPolicyTemperature = args.rootPolicyTemperature ?? 1.0;
  if (rootPolicyTemperature !== 1.0 && rootPolicyTemperature > 0) {
    let maxValue = passPrior;
    for (let i = 0; i < moveCount; i++) {
      if (priorsScratch[i]! > maxValue) maxValue = priorsScratch[i]!;
    }
    if (maxValue > 0) {
      const logMaxValue = Math.log(maxValue);
      const invTemp = 1.0 / rootPolicyTemperature;
      let tempSum = 0;
      for (let i = 0; i < moveCount; i++) {
        const prob = priorsScratch[i]!;
        if (prob > 0) {
          // Numerically stable way to raise to a power and normalize.
          const p = Math.exp((Math.log(prob) - logMaxValue) * invTemp);
          priorsScratch[i] = p;
          tempSum += p;
        }
      }
      if (passPrior > 0) {
        passPrior = Math.exp((Math.log(passPrior) - logMaxValue) * invTemp);
        tempSum += passPrior;
      }
      if (tempSum > 0) {
        const invTempSum = 1.0 / tempSum;
        for (let i = 0; i < moveCount; i++) priorsScratch[i] *= invTempSum;
        passPrior *= invTempSum;
      }
    }
  }

  const topMoves = scratch.topMoves;
  const topPriors = scratch.topPriors;
  const forcedMoves = args.forcedMoves;
  const maxKids = Math.max(0, maxChildren);
  let topCount = 0;
  let minIdx = 0;
  for (let i = 0; i < moveCount; i++) {
    // The mask restricts which moves the search may pick, like KataGo's
    // isAllowedRootMove. Policy itself is normalized over every legal move, so
    // masking does not inflate the priors of the moves that survive.
    if (allowedMoves && allowedMoves[movesScratch[i]!] === 0) continue;
    // Forced moves are added afterwards so they cannot be crowded out.
    if (forcedMoves && forcedMoves[movesScratch[i]!] === 1) continue;
    const prior = priorsScratch[i]!;
    if (topCount < maxKids) {
      topMoves[topCount] = movesScratch[i]!;
      topPriors[topCount] = prior;
      topCount++;
      if (topCount === maxKids) {
        minIdx = 0;
        for (let j = 1; j < topCount; j++) {
          if (topPriors[j]! < topPriors[minIdx]!) minIdx = j;
        }
      }
    } else if (maxKids > 0 && prior > topPriors[minIdx]!) {
      topMoves[minIdx] = movesScratch[i]!;
      topPriors[minIdx] = prior;
      minIdx = 0;
      for (let j = 1; j < topCount; j++) {
        if (topPriors[j]! < topPriors[minIdx]!) minIdx = j;
      }
    }
  }

  const order = scratch.order;
  order.length = topCount;
  for (let i = 0; i < topCount; i++) order[i] = i;
  order.sort((a, b) => {
    const diff = topPriors[b]! - topPriors[a]!;
    if (diff !== 0) return diff;
    return topMoves[a]! - topMoves[b]!;
  });

  const edges: Edge[] = [];
  for (let i = 0; i < order.length; i++) {
    const idx = order[i]!;
    edges.push({ move: topMoves[idx]!, prior: topPriors[idx]!, child: null, visits: 0 });
  }
  if (forcedMoves) {
    // Their real policy prior, so the search still treats them on their merits;
    // forcing only guarantees they are looked at at all.
    for (let i = 0; i < moveCount; i++) {
      const move = movesScratch[i]!;
      if (forcedMoves[move] !== 1) continue;
      if (allowedMoves && allowedMoves[move] === 0) continue;
      edges.push({ move, prior: priorsScratch[i]!, child: null, visits: 0 });
    }
  }
  edges.push({ move: PASS_MOVE, prior: passPrior, child: null, visits: 0 });

  node.edges = edges;
}

async function buildRootEval(args: {
  model: KataGoModelV8Tf;
  ownershipMode: OwnershipMode;
  rules: GameRules;
  rootSymmetrySamples?: number;
  komi: number;
  currentPlayer: Player;
  conservativePass: boolean;
  rootStones: Uint8Array;
  rootKoPoint: number;
  rootPrevStones: Uint8Array;
  rootPrevKoPoint: number;
  rootPrevPrevStones: Uint8Array;
  rootPrevPrevKoPoint: number;
  rootMoves: RecentMove[];
  rootHistory: SuperkoHistory | null;
  maxChildren: number;
  regionOfInterest?: RegionOfInterest | null;
  rootSymmetryPruning?: boolean;
  forcedRootMoves?: Uint8Array | null;
  avoidRootMoves?: Int32Array | null;
  playoutDoublingAdvantage?: number;
  playoutDoublingAdvantagePla?: Player;
  outputScaleMultiplier: number;
  /** KataGo ignorePreRootHistory: the root's history planes stay empty. */
  ignorePreRootHistory: boolean;
  /** KataGo enablePassingHacks. */
  enablePassingHacks: boolean;
  /** KataGo's defaultSymmetry for the root evaluation. Defaults to 0. */
  rootSymmetry?: number;
  /** KataGo rootPolicyTemperature, already interpolated for the turn number. */
  rootPolicyTemperature: number;
  node?: Node;
  preserveExistingChildren?: boolean;
}): Promise<{
  rootSymmetries: number[];
  roiMask: Uint8Array | null;
  rootNnWeight: number;
  rootLibertyMap: Uint8Array;
  rootOwnership: Float32Array;
  rootPolicy: Float32Array;
  rootValue: number;
  rootScoreLead: number;
  rootScoreMean: number;
  rootScoreMeanSq: number;
  rootUtility: number;
  recentScoreCenter: number;
  /** KataGo rootInfo's raw* fields: what the network said before any search. */
  rawWinRate: number;
  rawScoreLead: number;
  rawScoreSelfplay: number;
  rawScoreSelfplayStdev: number;
  rawNoResultProb: number;
  rawStWrError: number;
  rawStScoreError: number;
  rawVarTimeLeft: number;
}> {
  const rootSuperkoBanned = args.rootHistory?.bannedMoves(
    { stones: args.rootStones, koPoint: args.rootKoPoint }, playerToColor(args.currentPlayer), isSuicideLegal(args.rules)
  );
  const includeOwnership = args.ownershipMode !== 'none';
  const rootEval = await evaluateRootEval({
    model: args.model,
    includeOwnership,
    rules: args.rules,
    rootSymmetrySamples: args.rootSymmetrySamples,
    policyOptimism: ROOT_POLICY_OPTIMISM,
    komi: args.komi,
    playoutDoublingAdvantage: args.playoutDoublingAdvantage,
    playoutDoublingAdvantagePla: args.playoutDoublingAdvantagePla,
    outputScaleMultiplier: args.outputScaleMultiplier,
    state: {
      stones: args.rootStones,
      koPoint: args.rootKoPoint,
      superkoBanned: rootSuperkoBanned,
      prevStones: args.rootPrevStones,
      prevKoPoint: args.rootPrevKoPoint,
      prevPrevStones: args.rootPrevPrevStones,
      prevPrevKoPoint: args.rootPrevPrevKoPoint,
      currentPlayer: args.currentPlayer,
      recentMoves: takeRecentMoves(args.rootMoves, [], 5),
      conservativePassAndIsRoot: args.conservativePass,
      maxHistory: args.ignorePreRootHistory ? 0 : 5,
      enablePassingHacks: args.enablePassingHacks,
      symmetry: args.rootSymmetry,
    },
  });

  const rootLibertyMap = new Uint8Array(rootEval.libertyMap);
  const rootOwnership = new Float32Array(BOARD_AREA);
  if (includeOwnership) {
    if (!rootEval.ownership) throw new Error('Missing ownership output');
    const rootOwnershipSign = args.currentPlayer === 'black' ? 1 : -1;
    const rootSym = rootEval.symmetry;
    const rootSymOff = rootSym * BOARD_AREA;
    const symPosMap = rootSym === 0 ? null : getSymPosMap();
    for (let i = 0; i < BOARD_AREA; i++) {
      const symPos = rootSym === 0 ? i : symPosMap![rootSymOff + i]!;
      rootOwnership[i] = rootOwnershipSign * activatedOwnership(rootEval, symPos, args.outputScaleMultiplier);
    }
  }

  const { allowedMoves: rootAllowedMoves, roiMask, rootSymmetries } = buildRootMoveMask({
    regionOfInterest: args.regionOfInterest,
    stones: args.rootStones,
    koPoint: args.rootKoPoint,
    moveHistory: args.rootMoves,
    currentPlayer: args.currentPlayer,
    multiStoneSuicideLegal: isSuicideLegal(args.rules),
    symmetryPruning: args.rootSymmetryPruning,
    superkoHistory: args.rootHistory,
    ignorePreRootHistory: args.ignorePreRootHistory,
    avoidMoveUntil: args.avoidRootMoves,
  });
  const rootPolicy = new Float32Array(BOARD_AREA + 1);
  const policyNode = args.node ?? new Node(playerToColor(args.currentPlayer));
  const previousEdges = args.preserveExistingChildren === true ? policyNode.edges : null;
  expandNode({
    node: policyNode,
    stones: args.rootStones,
    koPoint: args.rootKoPoint,
    multiStoneSuicideLegal: isSuicideLegal(args.rules),
    superkoBanned: rootSuperkoBanned,
    policyLogits: rootEval.policy,
    policyLogitsSymmetry: rootEval.symmetry,
    passLogit: rootEval.passLogit,
    maxChildren: args.maxChildren,
    libertyMap: rootEval.libertyMap,
    allowedMoves: rootAllowedMoves ?? undefined,
    forcedMoves: args.forcedRootMoves ?? undefined,
    policyOut: rootPolicy,
    policyOutputScaling: args.outputScaleMultiplier,
    rootPolicyTemperature: args.rootPolicyTemperature,
  });
  if (previousEdges && policyNode.edges) {
    const previousByMove = new Map<number, Edge>();
    for (const edge of previousEdges) previousByMove.set(edge.move, edge);
    for (const edge of policyNode.edges) {
      const previous = previousByMove.get(edge.move);
      if (!previous) continue;
      edge.child = previous.child;
      edge.visits = previous.visits;
      edge.pvCache = previous.pvCache;
    }
  }

  const recentScoreCenter = computeRecentScoreCenter(-rootEval.blackScoreMean);
  // KataGo's winLossValue is winProb - lossProb, which is not the same as twice the
  // win probability minus one once the net gives a game any chance of ending with no
  // result: it counts a no-result as half a win to each side. Its reported winrate,
  // and KaTrain's, is 0.5 + 0.5 * that.
  const rootValue = blackWinLossValue(rootEval);
  const rootUtility = computeBlackUtilityFromEval({
    blackWinProb: rootEval.blackWinProb,
    blackNoResultProb: rootEval.blackNoResultProb,
    blackScoreMean: rootEval.blackScoreMean,
    blackScoreStdev: rootEval.blackScoreStdev,
    recentScoreCenter,
  });
  const rootScoreMeanSq = rootEval.blackScoreStdev * rootEval.blackScoreStdev + rootEval.blackScoreMean * rootEval.blackScoreMean;

  return {
    rootSymmetries,
    roiMask,
    rootNnWeight: computeWeightFromEval({
      blackScoreMean: rootEval.blackScoreMean,
      shorttermWinlossError: rootEval.shorttermWinlossError ?? -1,
      shorttermScoreError: rootEval.shorttermScoreError ?? -1,
      recentScoreCenter,
    }),
    rootLibertyMap,
    rootOwnership,
    rootPolicy,
    rootValue,
    rootScoreLead: rootEval.blackScoreLead,
    rootScoreMean: rootEval.blackScoreMean,
    rootScoreMeanSq,
    rootUtility,
    recentScoreCenter,
    rawWinRate: 0.5 + 0.5 * rootValue,
    rawScoreLead: rootEval.blackScoreLead,
    rawScoreSelfplay: rootEval.blackScoreMean,
    rawScoreSelfplayStdev: rootEval.blackScoreStdev,
    rawNoResultProb: rootEval.blackNoResultProb,
    rawStWrError: rootEval.shorttermWinlossError,
    rawStScoreError: rootEval.shorttermScoreError,
    rawVarTimeLeft: rootEval.varTimeLeft,
  };
}

// Mirrors KataGo config "Internal params" defaults (see cpp/configs/*_example.cfg).
const WIN_LOSS_UTILITY_FACTOR: number = 1.0;
const STATIC_SCORE_UTILITY_FACTOR: number = 0.1;
const DYNAMIC_SCORE_UTILITY_FACTOR: number = 0.3;
const DYNAMIC_SCORE_CENTER_ZERO_WEIGHT: number = 0.2;
const DYNAMIC_SCORE_CENTER_SCALE: number = 0.75;
const NO_RESULT_UTILITY_FOR_WHITE: number = 0.0;

function computeRecentScoreCenter(expectedWhiteScore: number): number {
  let recentScoreCenter = expectedWhiteScore * (1.0 - DYNAMIC_SCORE_CENTER_ZERO_WEIGHT);
  const cap = getSqrtBoardArea() * DYNAMIC_SCORE_CENTER_SCALE;
  if (recentScoreCenter > expectedWhiteScore + cap) recentScoreCenter = expectedWhiteScore + cap;
  if (recentScoreCenter < expectedWhiteScore - cap) recentScoreCenter = expectedWhiteScore - cap;
  return recentScoreCenter;
}

/**
 * KataGo's winLossValue from black's point of view: the win probability less the
 * loss probability, so a no-result counts half to each side. Reported winrates are
 * `0.5 + 0.5 *` this, which is not the same as the win probability alone.
 */
export function blackWinLossValue(ev: { blackWinProb: number; blackNoResultProb: number }): number {
  const blackLossProb = 1.0 - ev.blackWinProb - ev.blackNoResultProb;
  return ev.blackWinProb - blackLossProb;
}

function computeBlackUtilityFromEval(args: {
  blackWinProb: number;
  blackNoResultProb: number;
  blackScoreMean: number;
  blackScoreStdev: number;
  recentScoreCenter: number; // white score center
}): number {
  const sqrtBoardArea = getSqrtBoardArea();
  const blackLossProb = 1.0 - args.blackWinProb - args.blackNoResultProb;
  const whiteWinLossValue = blackLossProb - args.blackWinProb;
  const whiteScoreMean = -args.blackScoreMean;
  const whiteScoreStdev = args.blackScoreStdev;

  const staticScoreValue = expectedWhiteScoreValue({
    whiteScoreMean,
    whiteScoreStdev,
    center: 0.0,
    scale: 2.0,
    sqrtBoardArea,
  });

  const dynamicScoreValue =
    DYNAMIC_SCORE_UTILITY_FACTOR === 0.0
      ? 0.0
      : expectedWhiteScoreValue({
          whiteScoreMean,
          whiteScoreStdev,
          center: args.recentScoreCenter,
          scale: DYNAMIC_SCORE_CENTER_SCALE,
          sqrtBoardArea,
        });

  const whiteUtility =
    whiteWinLossValue * WIN_LOSS_UTILITY_FACTOR +
    args.blackNoResultProb * NO_RESULT_UTILITY_FOR_WHITE +
    staticScoreValue * STATIC_SCORE_UTILITY_FACTOR +
    dynamicScoreValue * DYNAMIC_SCORE_UTILITY_FACTOR;

  return -whiteUtility;
}

let VALUE_WEIGHT_EXPONENT: number = 0.25;
let USE_NOISE_PRUNING = true;
const NOISE_PRUNE_UTILITY_SCALE = 0.15;
const NOISE_PRUNING_CAP = 1e50;

type ChildWeightStats = {
  weightAdjusted: number;
  selfUtility: number;
  policy: number;
  value: number;
  noResult: number;
  scoreLead: number;
  scoreMean: number;
  scoreMeanSq: number;
  rawWeight?: number; // the child's own weightSum, before reweighting
  weightSqSum?: number;
  utility?: number;
  utilitySq?: number;
};

const SQRT_3 = Math.sqrt(3);

function tDistCdf3(z: number): number {
  const u = z / SQRT_3;
  const term = u / (1 + u * u);
  return 0.5 + (Math.atan(u) + term) / Math.PI;
}

function pruneNoiseWeight(stats: ChildWeightStats[]): number {
  if (stats.length <= 1) return stats.reduce((acc, s) => acc + s.weightAdjusted, 0);
  stats.sort((a, b) => b.policy - a.policy);

  let utilitySumSoFar = 0;
  let weightSumSoFar = 0;
  let rawPolicySumSoFar = 0;

  for (const s of stats) {
    const utility = s.selfUtility;
    const oldWeight = s.weightAdjusted;
    const rawPolicy = Math.max(1e-30, s.policy);
    let newWeight = oldWeight;

    if (weightSumSoFar > 0 && rawPolicySumSoFar > 0) {
      const avgUtilitySoFar = utilitySumSoFar / weightSumSoFar;
      const utilityGap = avgUtilitySoFar - utility;
      if (utilityGap > 0) {
        const weightShareFromRawPolicy = (weightSumSoFar * rawPolicy) / rawPolicySumSoFar;
        const lenientWeightShareFromRawPolicy = 2.0 * weightShareFromRawPolicy;
        if (oldWeight > lenientWeightShareFromRawPolicy) {
          const excessWeight = oldWeight - lenientWeightShareFromRawPolicy;
          let weightToSubtract = excessWeight * (1.0 - Math.exp(-utilityGap / NOISE_PRUNE_UTILITY_SCALE));
          if (weightToSubtract > NOISE_PRUNING_CAP) weightToSubtract = NOISE_PRUNING_CAP;
          newWeight = oldWeight - weightToSubtract;
          s.weightAdjusted = newWeight;
        }
      }
    }

    utilitySumSoFar += utility * newWeight;
    weightSumSoFar += newWeight;
    rawPolicySumSoFar += rawPolicy;
  }

  return weightSumSoFar;
}

function downweightBadChildrenAndNormalizeWeight(args: {
  stats: ChildWeightStats[];
  currentTotalWeight: number;
  desiredTotalWeight: number;
  amountToSubtract: number;
  amountToPrune: number;
}): void {
  const stats = args.stats;
  const desiredTotalWeight = args.desiredTotalWeight;
  if (stats.length === 0 || args.currentTotalWeight <= 0) return;

  if (VALUE_WEIGHT_EXPONENT === 0) {
    let currentTotalWeight = args.currentTotalWeight;
    for (const s of stats) {
      if (s.weightAdjusted < args.amountToPrune) {
        currentTotalWeight -= s.weightAdjusted;
        s.weightAdjusted = 0;
        continue;
      }
      const newWeight = s.weightAdjusted - args.amountToSubtract;
      if (newWeight <= 0) {
        currentTotalWeight -= s.weightAdjusted;
        s.weightAdjusted = 0;
      } else {
        currentTotalWeight -= args.amountToSubtract;
        s.weightAdjusted = newWeight;
      }
    }

    if (currentTotalWeight > 0 && currentTotalWeight !== desiredTotalWeight) {
      const factor = desiredTotalWeight / currentTotalWeight;
      for (const s of stats) s.weightAdjusted *= factor;
    }
    return;
  }

  const stdevs: number[] = new Array(stats.length);
  let simpleValueSum = 0;
  for (let i = 0; i < stats.length; i++) {
    const s = stats[i]!;
    const weight = s.weightAdjusted;
    if (weight <= 0) continue;
    const precision = 1.5 * Math.sqrt(weight);
    stdevs[i] = Math.sqrt(1e-8 + 1.0 / precision);
    simpleValueSum += s.selfUtility * weight;
  }

  const simpleValue = simpleValueSum / args.currentTotalWeight;
  let totalNewUnnormWeight = 0;

  for (let i = 0; i < stats.length; i++) {
    const s = stats[i]!;
    if (s.weightAdjusted < args.amountToPrune) {
      s.weightAdjusted = 0;
      continue;
    }
    const newWeight = s.weightAdjusted - args.amountToSubtract;
    if (newWeight <= 0) {
      s.weightAdjusted = 0;
      continue;
    }
    s.weightAdjusted = newWeight;

    const stdev = stdevs[i];
    if (!stdev || stdev <= 0) continue;
    const z = (s.selfUtility - simpleValue) / stdev;
    const p = tDistCdf3(z) + 0.0001;
    s.weightAdjusted *= Math.pow(p, VALUE_WEIGHT_EXPONENT);
    totalNewUnnormWeight += s.weightAdjusted;
  }

  if (totalNewUnnormWeight <= 0) return;
  const factor = desiredTotalWeight / totalNewUnnormWeight;
  for (const s of stats) s.weightAdjusted *= factor;
}

// KataGo subtreeValueBias defaults (cpp/program/setup.cpp): factor 0.45, weight
// exponent 0.85. The idea is that if the search keeps finding a node's own network
// evaluation too optimistic, positions that look locally the same are probably
// getting the same error, so correct them all by the average of what was found.
let SUBTREE_VALUE_BIAS_FACTOR: number = 0.45;
const SUBTREE_VALUE_BIAS_WEIGHT_EXPONENT = 0.85;
const SUBTREE_BIAS_PATTERN_RADIUS = 2; // KataGo hashes a 5x5 window

/** How many of the human net's favourite moves to guarantee a place in the report. */
const DEFAULT_HUMAN_MOVE_COUNT = 5;
/**
 * Visits every such move gets before normal selection takes over. Being a child is
 * not enough: a move a strong net dislikes would otherwise sit at zero visits and
 * the report could not say what it costs, which is the whole point of showing it.
 */
const HUMAN_MOVE_MIN_VISITS = 2;

type SubtreeBiasEntry = { deltaUtilitySum: number; weightSum: number };

/**
 * KataGo's SubtreeValueBiasTable, keyed the same way: the move that led here, the
 * move before that, the local 5x5 pattern (with atari marked) on the board before
 * the move, whose turn it is, and any ko ban.
 */
class SubtreeBiasTable {
  private entries = new Map<string, SubtreeBiasEntry>();
  epoch = 0;

  get(key: string): SubtreeBiasEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { deltaUtilitySum: 0, weightSum: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Drops everything, e.g. when the search re-roots and old nodes fall away. */
  reset(): void {
    this.entries.clear();
    this.epoch++;
  }
}

function buildSubtreeBiasKey(args: {
  stones: Uint8Array; // board BEFORE the move
  libertyMap: Uint8Array;
  move: number;
  parentMove: number;
  koPoint: number;
  pla: StoneColor;
}): string {
  const { stones, libertyMap, move, parentMove, koPoint, pla } = args;
  let key = `${pla}|${parentMove}|${move}|${koPoint}`;
  if (move === PASS_MOVE) return key;

  const x = move % BOARD_SIZE;
  const y = (move / BOARD_SIZE) | 0;
  const r = SUBTREE_BIAS_PATTERN_RADIUS;
  const dxMin = Math.max(-r, -x);
  const dxMax = Math.min(r, BOARD_SIZE - 1 - x);
  const dyMin = Math.max(-r, -y);
  const dyMax = Math.min(r, BOARD_SIZE - 1 - y);
  key += '|';
  for (let dy = dyMin; dy <= dyMax; dy++) {
    for (let dx = dxMin; dx <= dxMax; dx++) {
      const pos = (y + dy) * BOARD_SIZE + (x + dx);
      const color = stones[pos] as StoneColor;
      key += color === EMPTY ? '.' : color === BLACK ? (libertyMap[pos] === 1 ? 'b' : 'B') : libertyMap[pos] === 1 ? 'w' : 'W';
    }
    key += '/';
  }
  return key;
}

// KataGo useUncertainty defaults (cpp/program/setup.cpp): on, coeff 0.25, exponent 1,
// max weight 8. Only nets from model version 10 on predict the shortterm errors this
// needs; with older nets every visit keeps weight 1, exactly as in KataGo.
let USE_UNCERTAINTY = true;
const UNCERTAINTY_COEFF = 0.25;
const UNCERTAINTY_EXPONENT = 1.0;
const UNCERTAINTY_MAX_WEIGHT = 8.0;

/** KataGo Search::getApproxScoreUtilityDerivative. */
function approxScoreUtilityDerivative(whiteScoreMean: number, recentScoreCenter: number): number {
  const sqrtBoardArea = getSqrtBoardArea();
  const staticDerivative = whiteDScoreValueDScoreSmoothNoDrawAdjust({
    finalWhiteMinusBlackScore: whiteScoreMean,
    center: 0.0,
    scale: 2.0,
    sqrtBoardArea,
  });
  const dynamicDerivative = whiteDScoreValueDScoreSmoothNoDrawAdjust({
    finalWhiteMinusBlackScore: whiteScoreMean,
    center: recentScoreCenter,
    scale: DYNAMIC_SCORE_CENTER_SCALE,
    sqrtBoardArea,
  });
  return staticDerivative * STATIC_SCORE_UTILITY_FACTOR + dynamicDerivative * DYNAMIC_SCORE_UTILITY_FACTOR;
}

/**
 * KataGo Search::computeWeightFromNNOutput: a visit counts for less when the network
 * says its own judgement of this position is still moving around a lot.
 */
export function computeWeightFromEval(args: {
  blackScoreMean: number;
  shorttermWinlossError: number;
  shorttermScoreError: number;
  recentScoreCenter: number;
}): number {
  if (!USE_UNCERTAINTY) return 1.0;
  // Nets before model version 10 do not predict these and report -1.
  if (!(args.shorttermWinlossError >= 0) || !(args.shorttermScoreError >= 0)) return 1.0;

  const whiteScoreMean = -args.blackScoreMean;
  const utilityUncertaintyWL = WIN_LOSS_UTILITY_FACTOR * args.shorttermWinlossError;
  const utilityUncertaintyScore =
    approxScoreUtilityDerivative(whiteScoreMean, args.recentScoreCenter) * args.shorttermScoreError;
  const utilityUncertainty = utilityUncertaintyWL + utilityUncertaintyScore;

  const poweredUncertainty =
    UNCERTAINTY_EXPONENT === 1.0
      ? utilityUncertainty
      : UNCERTAINTY_EXPONENT === 0.5
        ? Math.sqrt(utilityUncertainty)
        : Math.pow(utilityUncertainty, UNCERTAINTY_EXPONENT);

  const baselineUncertainty = UNCERTAINTY_COEFF / UNCERTAINTY_MAX_WEIGHT;
  return UNCERTAINTY_COEFF / (poweredUncertainty + baselineUncertainty);
}

/**
 * KataGo Search::recomputeNodeStats: rebuild a node's stats from its children plus
 * its own evaluation, reweighting the children by noise pruning and by how bad they
 * look relative to their siblings. Visits are counted separately by the caller.
 */
// Recomputing runs once per node per playout, so the child stats are pooled rather
// than allocated each time (KataGo keeps the same buffer per search thread).
const recomputeStatsPool: ChildWeightStats[] = [];
const recomputeStatsWork: ChildWeightStats[] = [];

function recomputeNodeStats(node: Node): void {
  const edges = node.edges;
  const stats = recomputeStatsWork;
  stats.length = 0;
  let origTotalChildWeight = 0;

  if (edges) {
    for (const e of edges) {
      const child = e.child;
      if (!child || child.visits <= 0 || child.weightSum <= 0 || e.visits <= 0) continue;
      const edgeWeight = edgeChildWeight(e);
      const childUtility = child.utilityAvg;
      const idx = stats.length;
      let entry = recomputeStatsPool[idx];
      if (!entry) {
        entry = {
          weightAdjusted: 0,
          rawWeight: 0,
          weightSqSum: 0,
          selfUtility: 0,
          policy: 0,
          value: 0,
          noResult: 0,
          scoreLead: 0,
          scoreMean: 0,
          scoreMeanSq: 0,
          utility: 0,
          utilitySq: 0,
        };
        recomputeStatsPool[idx] = entry;
      }
      entry.weightAdjusted = edgeWeight;
      entry.rawWeight = child.weightSum;
      entry.weightSqSum = child.weightSqSum;
      entry.selfUtility = node.playerToMove === BLACK ? childUtility : -childUtility;
      entry.policy = e.prior;
      entry.value = child.valueAvg;
      entry.noResult = child.noResultAvg;
      entry.scoreLead = child.scoreLeadAvg;
      entry.scoreMean = child.scoreMeanAvg;
      entry.scoreMeanSq = child.scoreMeanSqAvg;
      entry.utility = childUtility;
      entry.utilitySq = child.utilitySqAvg;
      stats.push(entry);
      origTotalChildWeight += edgeWeight;
    }
  }

  let currentTotalChildWeight = origTotalChildWeight;
  if (USE_NOISE_PRUNING && stats.length > 0) currentTotalChildWeight = pruneNoiseWeight(stats);
  if (stats.length > 0) {
    downweightBadChildrenAndNormalizeWeight({
      stats,
      currentTotalWeight: currentTotalChildWeight,
      desiredTotalWeight: currentTotalChildWeight,
      amountToSubtract: 0,
      amountToPrune: 0,
    });
  }

  let valueSum = 0;
  let noResultSum = 0;
  let scoreLeadSum = 0;
  let scoreMeanSum = 0;
  let scoreMeanSqSum = 0;
  let utilitySum = 0;
  let utilitySqSum = 0;
  let weightSqSum = 0;
  let weightSum = currentTotalChildWeight;

  for (const child of stats) {
    const desiredWeight = child.weightAdjusted;
    if (desiredWeight <= 0) continue;
    const rawWeight = child.rawWeight ?? desiredWeight;
    const weightScaling = rawWeight > 0 ? desiredWeight / rawWeight : 0;
    valueSum += desiredWeight * child.value;
    noResultSum += desiredWeight * child.noResult;
    scoreLeadSum += desiredWeight * child.scoreLead;
    scoreMeanSum += desiredWeight * child.scoreMean;
    scoreMeanSqSum += desiredWeight * child.scoreMeanSq;
    utilitySum += desiredWeight * (child.utility ?? 0);
    utilitySqSum += desiredWeight * (child.utilitySq ?? 0);
    weightSqSum += weightScaling * weightScaling * (child.weightSqSum ?? 0);
  }

  // The node's own evaluation is one more weighted term, corrected by whatever the
  // search h…21396 tokens truncated…mputeStateHash(
      this.rootStones,
      this.rootKoPoint,
      this.rootNode.playerToMove,
      this.rootConsecutivePasses,
      this.rootGraphHash
    );
    this.rootHistory?.reset();
    if (this.rootHistory) {
      this.rootGraphHash[0] ^= this.rootHistory.hash0;
      this.rootGraphHash[1] ^= this.rootHistory.hash1;
    }
  }

  /** How many times the search found a position it had already reached another way. */
  getTranspositionHits(): number {
    return this.transpositionHits;
  }

  /**
   * KataGo Search::shouldSuppressPass (cpp/search/searchhelpers.cpp). Under territory
   * scoring, passing is taken off the table while some move that is not deep in the
   * opponent's territory still costs nothing to play, so dame get filled instead of
   * left for the opponent to tidy up.
   */
  private shouldSuppressPass(): boolean {
    if (!this.fillDameBeforePass) return false;
    if (this.rules !== 'japanese' && this.rules !== 'korean') return false;
    const ownership = this.ownershipMode === 'none' ? null : this.rootOwnership;
    if (!ownership) return false;
    const edges = this.rootNode.edges;
    if (!edges) return false;

    const pla = this.rootNode.playerToMove;
    const sign = pla === BLACK ? 1 : -1;

    let passEdge: Edge | null = null;
    for (const e of edges) {
      if (e.move === PASS_MOVE && e.child) {
        passEdge = e;
        break;
      }
    }
    if (!passEdge?.child) return false;
    const passWeight = edgeChildWeight(passEdge);
    if (passEdge.child.visits <= 0 || passWeight <= 1e-10) return false;
    const passUtility = sign * passEdge.child.utilityAvg;
    const passScoreMean = sign * passEdge.child.scoreMeanAvg;
    const passLead = sign * passEdge.child.scoreLeadAvg;

    // Ownership is stored from black's perspective, so flip it for white.
    const extreme = 0.95;
    const ownedByPla = (pos: number): number => sign * ownership[pos]!;

    for (const e of edges) {
      const child = e.child;
      if (!child || e.move === PASS_MOVE) continue;

      // A point the opponent all but owns is not dame, unless it touches something
      // this player owns, in which case it is still worth playing.
      const oppOwned = ownedByPla(e.move) < -extreme;
      if (oppOwned) {
        let adjToPlaOwned = false;
        const nStart = NEIGHBOR_STARTS[e.move]!;
        const nCount = NEIGHBOR_COUNTS[e.move]!;
        for (let i = 0; i < nCount; i++) {
          if (ownedByPla(NEIGHBOR_LIST[nStart + i]!) > extreme) {
            adjToPlaOwned = true;
            break;
          }
        }
        if (!adjToPlaOwned) continue;
      }

      const childWeight = edgeChildWeight(e);
      // Too little of the search behind it to trust the comparison.
      if ((e.visits <= 500 && childWeight <= 2 * Math.sqrt(passWeight)) || childWeight <= 1e-10) continue;

      if (
        sign * child.utilityAvg > passUtility - 0.1 &&
        sign * child.scoreMeanAvg > passScoreMean - 0.5 &&
        sign * child.scoreLeadAvg > passLead - 0.5
      ) {
        return true;
      }
    }
    return false;
  }

  /** rootPolicyTemperature for the root's turn number, KataGo's interpolateEarly. */
  private effectiveRootPolicyTemperature(turnNumber: number): number {
    if (this.rootPolicyTemperature === 1 && this.rootPolicyTemperatureEarly === 1) return 1;
    return interpolateEarly({
      halflife: CHOSEN_MOVE_TEMPERATURE_HALFLIFE,
      earlyValue: this.rootPolicyTemperatureEarly,
      value: this.rootPolicyTemperature,
      turnNumber,
      boardWidth: BOARD_SIZE,
      boardHeight: BOARD_SIZE,
    });
  }

  static async create(args: {
    model: KataGoModelV8Tf;
    board: BoardState;
    previousBoard?: BoardState;
    previousPreviousBoard?: BoardState;
    currentPlayer: Player;
    moveHistory: Move[];
    repetitionHistory?: readonly string[];
    komi: number;
    rules: GameRules;
    nnRandomize: boolean;
    conservativePass: boolean;
    maxChildren: number;
    ownershipMode: OwnershipMode;
    wideRootNoise: number;
    /** Doublings of search one colour is treated as having; 0 disables it. */
    playoutDoublingAdvantage?: number;
    playoutDoublingAdvantagePla?: Player;
    rootSymmetrySamples?: number;
    regionOfInterest?: RegionOfInterest | null;
    rootSymmetryPruning?: boolean;
    /** Human SL policy for the root position, used to widen the candidate list. */
    humanPolicy?: ArrayLike<number> | null;
    humanMoveCount?: number;
    /**
     * KataGo humanSLRootExploreProbWeightless / Weightful. Both default to 0, as
     * KataGo's do; its human-bot config sets the weightless one to 0.8.
     */
    humanSlRootExploreProbWeightless?: number;
    humanSlRootExploreProbWeightful?: number;
    /**
     * KataGo ignorePreRootHistory. Defaults to true, as it does for KataGo's
     * analysis engine (Setup::DEFAULT_ANALYSIS_IGNORE_PRE_ROOT_HISTORY).
     */
    ignorePreRootHistory?: boolean;
    /** KataGo enablePassingHacks. Defaults to true, as it does for analysis and GTP. */
    enablePassingHacks?: boolean;
    /** KataGo useGraphSearch. Defaults to true, as it does for everything but distributed. */
    useGraphSearch?: boolean;
    /** KataGo fillDameBeforePass. Only ever bites under territory scoring. */
    fillDameBeforePass?: boolean;
    /**
     * KataGo rootPolicyTemperature: above 1 the root policy is flattened, so the
     * search spreads over more moves. `Early` is the value on move 0, decaying to
     * the other over KataGo's chosenMoveTemperatureHalflife. Both default to 1.
     */
    rootPolicyTemperature?: number;
    rootPolicyTemperatureEarly?: number;
    /**
     * KataGo's defaultSymmetry: which of the eight symmetries to evaluate the root
     * with. Defaults to 0. Only useful for reproducing a recorded run.
     */
    rootSymmetry?: number;
    /**
     * KataGo avoidMoveUntilByLoc, one array per player: the ply before which each
     * move is off limits. Index BOARD_AREA is the pass; zero means no restriction.
     */
    avoidMoveUntilBlack?: Int32Array | null;
    avoidMoveUntilWhite?: Int32Array | null;
  }): Promise<MctsSearch> {
    const outputScaleMultiplier = args.model.postProcessParams?.outputScaleMultiplier ?? 1.0;
    const rootSymmetrySamples = clampRootSymmetrySamples(args.rootSymmetrySamples);
    const rootStones = boardStateToStones(args.board);
    const rootHistory = createSuperkoHistory(args);
    const rootKoPoint = computeKoPointFromPrevious({ board: args.board, previousBoard: args.previousBoard, moveHistory: args.moveHistory, rules: args.rules });

    const rootPrevStones = args.previousBoard ? boardStateToStones(args.previousBoard) : rootStones;
    const rootPrevKoPoint = computeKoPointAfterMove(
      args.previousPreviousBoard,
      args.moveHistory.length >= 2 ? args.moveHistory[args.moveHistory.length - 2]! : null,
      args.rules
    );
    const rootPrevPrevStones = args.previousPreviousBoard ? boardStateToStones(args.previousPreviousBoard) : rootPrevStones;
    const rootPrevPrevKoPoint = -1;

    const rootMoves: RecentMove[] = args.moveHistory.map((m) => ({
      move: m.x < 0 || m.y < 0 ? PASS_MOVE : m.y * BOARD_SIZE + m.x,
      player: m.player,
    }));

    const forcedRootMoves = topHumanMovesMask(args.humanPolicy, args.humanMoveCount ?? DEFAULT_HUMAN_MOVE_COUNT);
    const ignorePreRootHistory = args.ignorePreRootHistory !== false;
    const enablePassingHacks = args.enablePassingHacks ?? ENABLE_PASSING_HACKS;
    const useGraphSearch = args.useGraphSearch ?? USE_GRAPH_SEARCH;
    const fillDameBeforePass = args.fillDameBeforePass ?? FILL_DAME_BEFORE_PASS;
    const rootPolicyTemperature = Math.max(0.01, Math.min(100, args.rootPolicyTemperature ?? 1));
    const rootPolicyTemperatureEarly = Math.max(
      0.01,
      Math.min(100, args.rootPolicyTemperatureEarly ?? rootPolicyTemperature)
    );
    const effectiveRootPolicyTemperature =
      rootPolicyTemperature === 1 && rootPolicyTemperatureEarly === 1
        ? 1
        : interpolateEarly({
            halflife: CHOSEN_MOVE_TEMPERATURE_HALFLIFE,
            earlyValue: rootPolicyTemperatureEarly,
            value: rootPolicyTemperature,
            turnNumber: rootMoves.length,
            boardWidth: BOARD_SIZE,
            boardHeight: BOARD_SIZE,
          });
    const weightlessProb = Math.max(0, Math.min(1, args.humanSlRootExploreProbWeightless ?? 0));
    const weightfulProb = Math.max(0, Math.min(1, args.humanSlRootExploreProbWeightful ?? 0));
    const humanExplore: HumanExploreParams | null =
      args.humanPolicy && weightlessProb + weightfulProb > 0
        ? { policy: Float32Array.from(args.humanPolicy), weightlessProb, weightfulProb }
        : null;
    const rootNode = new Node(playerToColor(args.currentPlayer));
    const {
      rootSymmetries,
      roiMask,
      rootNnWeight,
      rootLibertyMap,
      rootOwnership,
      rootPolicy,
      rootValue,
      rootScoreLead,
      rootScoreMean,
      rootScoreMeanSq,
      rootUtility,
      recentScoreCenter,
      rawWinRate,
      rawScoreLead,
      rawScoreSelfplay,
      rawScoreSelfplayStdev,
      rawNoResultProb,
      rawStWrError,
      rawStScoreError,
      rawVarTimeLeft,
    } = await buildRootEval({
      model: args.model,
      ownershipMode: args.ownershipMode,
      rules: args.rules,
      rootSymmetrySamples,
      komi: args.komi,
      currentPlayer: args.currentPlayer,
      conservativePass: args.conservativePass,
      rootStones,
      rootKoPoint,
      rootPrevStones,
      rootPrevKoPoint,
      rootPrevPrevStones,
      rootPrevPrevKoPoint,
      rootMoves,
      rootHistory,
      maxChildren: args.maxChildren,
      regionOfInterest: args.regionOfInterest,
      rootSymmetryPruning: args.rootSymmetryPruning,
      forcedRootMoves,
      avoidRootMoves:
        args.currentPlayer === 'black' ? (args.avoidMoveUntilBlack ?? null) : (args.avoidMoveUntilWhite ?? null),
      playoutDoublingAdvantage: args.playoutDoublingAdvantage,
      playoutDoublingAdvantagePla: args.playoutDoublingAdvantagePla,
      outputScaleMultiplier,
      ignorePreRootHistory,
      enablePassingHacks,
      rootPolicyTemperature: effectiveRootPolicyTemperature,
      rootSymmetry: args.rootSymmetry,
      node: rootNode,
    });
    rootNode.ownership = rootOwnership;
    rootNode.visits = 1;
    rootNode.nnValue = rootValue;
    rootNode.nnNoResult = rawNoResultProb;
    rootNode.nnScoreLead = rootScoreLead;
    rootNode.nnScoreMean = rootScoreMean;
    rootNode.nnScoreMeanSq = rootScoreMeanSq;
    rootNode.nnUtility = rootUtility;
    rootNode.nnWeight = rootNnWeight;
    recomputeNodeStats(rootNode);

    const rootPrevLibertyMap =
      rootPrevStones === rootStones ? rootLibertyMap : computeLibertyMapInto(rootPrevStones, new Uint8Array(BOARD_AREA));

    const rootEndingBonus = computeEndingScoreBonuses({
      stones: rootStones,
      libertyMap: rootLibertyMap,
      koPoint: rootKoPoint,
      ownership: args.ownershipMode === 'none' ? null : rootOwnership,
      currentPlayer: args.currentPlayer,
      rules: args.rules,
    });

    return new MctsSearch({
      model: args.model,
      ownershipMode: args.ownershipMode,
      maxChildren: args.maxChildren,
      currentPlayer: args.currentPlayer,
      komi: args.komi,
      rules: args.rules,
      nnRandomize: args.nnRandomize,
      conservativePass: args.conservativePass,
      wideRootNoise: args.wideRootNoise,
      playoutDoublingAdvantage: args.playoutDoublingAdvantage ?? 0,
      playoutDoublingAdvantagePla: args.playoutDoublingAdvantagePla ?? 'black',
      rootSymmetrySamples,
      rootStones,
      rootKoPoint,
      rootPrevStones,
      rootPrevKoPoint,
      rootMoves,
      rootHistory,
      rootNode,
      rootLibertyMap,
      rootPrevLibertyMap,
      rootPolicy,
      rootOwnership,
      recentScoreCenter,
      rand: new Rand(),
      outputScaleMultiplier,
      rootSymmetries,
      roiMask,
      rootSymmetryPruning: args.rootSymmetryPruning !== false,
      rootEndingBonus,
      forcedRootMoves,
      humanExplore,
      ignorePreRootHistory,
      enablePassingHacks,
      useGraphSearch,
      fillDameBeforePass,
      avoidMoveUntilBlack: args.avoidMoveUntilBlack ?? null,
      avoidMoveUntilWhite: args.avoidMoveUntilWhite ?? null,
      rootRaw: {
        winRate: rawWinRate,
        scoreLead: rawScoreLead,
        scoreSelfplay: rawScoreSelfplay,
        scoreSelfplayStdev: rawScoreSelfplayStdev,
        noResultProb: rawNoResultProb,
        stWrError: rawStWrError,
        stScoreError: rawStScoreError,
        varTimeLeft: rawVarTimeLeft,
      },
      rootPolicyTemperature,
      rootPolicyTemperatureEarly,
    });
  }

  async reRootToChild(args: {
    move: number;
    board: BoardState;
    previousBoard?: BoardState;
    previousPreviousBoard?: BoardState;
    currentPlayer: Player;
    moveHistory: Move[];
    repetitionHistory?: readonly string[];
    komi: number;
    rules: GameRules;
    regionOfInterest?: RegionOfInterest | null;
  }): Promise<boolean> {
    if (args.rules !== this.rules || args.komi !== this.komi) return false;
    const edges = this.rootNode.edges;
    if (!edges || edges.length === 0) return false;
    const target = edges.find((edge) => edge.move === args.move);
    if (!target?.child) return false;
    const child = target.child;
    if (child.playerToMove !== playerToColor(args.currentPlayer)) return false;

    const rootStones = boardStateToStones(args.board);
    const rootHistory = args.repetitionHistory === undefined && this.rootHistory
      ? this.rootHistory.withPosition(rootStones, child.playerToMove)
      : createSuperkoHistory(args);
    if (this.rootHistory && (!rootHistory || !this.rootHistory.isContinuation(rootHistory, rootStones, child.playerToMove))) return false;
    const rootKoPoint = computeKoPointFromPrevious({ board: args.board, previousBoard: args.previousBoard, moveHistory: args.moveHistory, rules: args.rules });

    const rootPrevStones = args.previousBoard ? boardStateToStones(args.previousBoard) : rootStones;
    const rootPrevKoPoint = computeKoPointAfterMove(
      args.previousPreviousBoard,
      args.moveHistory.length >= 2 ? args.moveHistory[args.moveHistory.length - 2]! : null,
      args.rules
    );
    const rootPrevPrevStones = args.previousPreviousBoard ? boardStateToStones(args.previousPreviousBoard) : rootPrevStones;
    const rootPrevPrevKoPoint = -1;

    const rootMoves: RecentMove[] = args.moveHistory.map((m) => ({
      move: m.x < 0 || m.y < 0 ? PASS_MOVE : m.y * BOARD_SIZE + m.x,
      player: m.player,
    }));

    const shouldExpandRoot = !child.edges || child.edges.length === 0;
    const {
      rootSymmetries,
      roiMask,
      rootNnWeight,
      rootLibertyMap,
      rootOwnership,
      rootPolicy,
      rootValue,
      rootScoreLead,
      rootScoreMean,
      rootScoreMeanSq,
      rootUtility,
      recentScoreCenter,
      rawWinRate,
      rawScoreLead,
      rawScoreSelfplay,
      rawScoreSelfplayStdev,
      rawNoResultProb,
      rawStWrError,
      rawStScoreError,
      rawVarTimeLeft,
    } = await buildRootEval({
      model: this.model,
      ownershipMode: this.ownershipMode,
      rules: args.rules,
      rootSymmetryPruning: this.rootSymmetryPruning,
      rootSymmetrySamples: this.rootSymmetrySamples,
      komi: args.komi,
      currentPlayer: args.currentPlayer,
      conservativePass: this.conservativePass,
      rootStones,
      rootKoPoint,
      rootPrevStones,
      rootPrevKoPoint,
      rootPrevPrevStones,
      rootPrevPrevKoPoint,
      rootMoves,
      rootHistory,
      maxChildren: this.maxChildren,
      regionOfInterest: args.regionOfInterest,
      playoutDoublingAdvantage: this.playoutDoublingAdvantage,
      playoutDoublingAdvantagePla: this.playoutDoublingAdvantagePla,
      outputScaleMultiplier: this.outputScaleMultiplier,
      ignorePreRootHistory: this.ignorePreRootHistory,
      enablePassingHacks: this.enablePassingHacks,
      rootPolicyTemperature: this.effectiveRootPolicyTemperature(rootMoves.length),
      node: child,
      preserveExistingChildren: !shouldExpandRoot,
    });

    const rootPrevLibertyMap =
      rootPrevStones === rootStones ? rootLibertyMap : computeLibertyMapInto(rootPrevStones, new Uint8Array(BOARD_AREA));

    if (shouldExpandRoot) child.visits = 1;
    child.nnValue = rootValue;
    child.nnNoResult = rawNoResultProb;
    child.nnScoreLead = rootScoreLead;
    child.nnScoreMean = rootScoreMean;
    child.nnScoreMeanSq = rootScoreMeanSq;
    child.nnUtility = rootUtility;
    child.nnWeight = rootNnWeight;
    recomputeNodeStats(child);
    child.pendingEval = false;
    child.inFlight = 0;
    child.ownership = rootOwnership;

    this.rootNode = child;
    this.rootStones = rootStones;
    this.rootKoPoint = rootKoPoint;
    this.rootPrevStones = rootPrevStones;
    this.rootPrevKoPoint = rootPrevKoPoint;
    this.rootMoves = rootMoves;
    this.rootHistory = rootHistory;
    this.rootLibertyMap = rootLibertyMap;
    this.rootPrevLibertyMap = rootPrevLibertyMap;
    this.rootPolicy = rootPolicy;
    this.rootOwnership = rootOwnership;
    this.recentScoreCenter = recentScoreCenter;
    this.currentPlayer = args.currentPlayer;
    this.rootSymmetries = rootSymmetries;
    this.roiMask = roiMask;
    // The human moves belonged to the old root; the caller starts a new search when
    // it wants them for the new position.
    this.forcedRootMoves = null;
    this.humanExplore = null;
    this.rootRaw = {
      winRate: rawWinRate,
      scoreLead: rawScoreLead,
      scoreSelfplay: rawScoreSelfplay,
      scoreSelfplayStdev: rawScoreSelfplayStdev,
      noResultProb: rawNoResultProb,
      stWrError: rawStWrError,
      stScoreError: rawStScoreError,
      varTimeLeft: rawVarTimeLeft,
    };
    this.resetGraphSearchState();
    // Nodes outside the new root's subtree are gone, and their contributions to the
    // bias table would linger, so start the table over (KataGo decays them instead).
    this.subtreeBiasTable.reset();
    this.rootEndingBonus = computeEndingScoreBonuses({
      stones: rootStones,
      libertyMap: rootLibertyMap,
      koPoint: rootKoPoint,
      ownership: this.ownershipMode === 'none' ? null : rootOwnership,
      currentPlayer: args.currentPlayer,
      rules: args.rules,
    });
    this.treeOwnershipCache = null;

    return true;
  }

  async run(args: {
    visits: number;
    maxTimeMs: number;
    batchSize: number;
    shouldAbort?: () => boolean;
  }): Promise<boolean> {
    const maxVisits = Math.max(16, Math.min(args.visits, ENGINE_MAX_VISITS));
    const maxTimeMs = Math.max(25, Math.min(args.maxTimeMs, ENGINE_MAX_TIME_MS));
    // Not a clamp on its own: with NaN, or a string that came through a
    // message, both comparisons are false and this yields NaN. The batch loop
    // then collects nothing, the root gains no visit, and the stuck-batch
    // guard below ends the search with no result at all.
    const batchSize = Number.isFinite(args.batchSize) ? Math.max(1, Math.min(args.batchSize, 64)) : 1;
    const shouldAbort = args.shouldAbort;
    const multiStoneSuicideLegal = isSuicideLegal(this.rules);
    // Territory scoring still needs dead-stone agreement or an encore; retain
    // neural evaluation there until those endgame rules are implemented.
    const scoreTerminalNodes = isAreaScoring(this.rules);

    if (shouldAbort?.()) return true;
    if (this.rootNode.visits >= maxVisits) return shouldAbort?.() ?? false;

    const neededBoardCapacity = batchSize * BOARD_AREA;
    if (this.jobStonesScratch.length < neededBoardCapacity) this.jobStonesScratch = new Uint8Array(neededBoardCapacity);
    if (this.jobPrevStonesScratch.length < neededBoardCapacity) this.jobPrevStonesScratch = new Uint8Array(neededBoardCapacity);
    if (this.jobPrevPrevStonesScratch.length < neededBoardCapacity) this.jobPrevPrevStonesScratch = new Uint8Array(neededBoardCapacity);
    if (this.jobLibertyMapScratch.length < neededBoardCapacity) this.jobLibertyMapScratch = new Uint8Array(neededBoardCapacity);
    if (this.jobPrevLibertyMapScratch.length < neededBoardCapacity) this.jobPrevLibertyMapScratch = new Uint8Array(neededBoardCapacity);
    if (this.jobPrevPrevLibertyMapScratch.length < neededBoardCapacity)
      this.jobPrevPrevLibertyMapScratch = new Uint8Array(neededBoardCapacity);

    const sim: SimPosition = { stones: this.rootStones.slice(), koPoint: this.rootKoPoint };
    const captureStack: number[] = [];
    const undoMoves: number[] = [];
    const undoPlayers: StoneColor[] = [];
    const undoSnapshots: UndoSnapshot[] = [];
    const pathMoves: RecentMove[] = [];
    const libertyMapStack = this.libertyMapStack;
    libertyMapStack[0] = this.rootLibertyMap;
    const libertySeedsScratch = this.libertySeedsScratch;

    const deadline = getAnimationNow() + maxTimeMs;
    let timeCheckCounter = 0;
    const timeCheckMask = 0x1f;
    const timeExceeded = (): boolean => {
      if ((timeCheckCounter++ & timeCheckMask) !== 0) return false;
      return getAnimationNow() >= deadline;
    };

    // A weightless playout never credits the root, so a search that spends many of
    // them can want far more playouts than visits. KataGo bounds that with
    // maxPlayouts; in a browser we always want some bound, so here is one.
    let playouts = 0;
    const maxPlayouts = maxVisits * 8;

    while (this.rootNode.visits < maxVisits && playouts < maxPlayouts && !timeExceeded()) {
      if (shouldAbort && getAnimationNow() - this.lastCancellationYieldAt >= 50) {
        // CPU/WASM tensor reads can resolve entirely through microtasks. Awaiting
        // them does not let a worker receive the newer request that changes the
        // abort flag. Yield between complete batches, with no in-flight paths,
        // so queued messages can preempt this search and its tree stays reusable.
        // Keep the timestamp across short progress-report slices too.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        this.lastCancellationYieldAt = getAnimationNow();
      }
      if (shouldAbort?.()) return true;
      const visitsBeforeBatch = this.rootNode.visits;
      // Weightless playouts do not raise the root's visit count, so they must not
      // count against the batch's estimate of how close the limit is.
      let weightlessJobs = 0;
      const jobs: Array<{
        leaf: Node;
        path: Node[];
        edgePath: Edge[];
        weightlessFrom: number;
        stones: Uint8Array;
        koPoint: number;
        libertyMap: Uint8Array;
        superkoBanned?: Uint8Array;
        prevStones: Uint8Array;
        prevKoPoint: number;
        prevLibertyMap?: Uint8Array;
        prevPrevStones: Uint8Array;
        prevPrevKoPoint: number;
        prevPrevLibertyMap?: Uint8Array;
        currentPlayer: Player;
        recentMoves: RecentMove[];
        maxHistory: number;
        enablePassingHacks: boolean;
      }> = [];

      let attempts = 0;
      while (
        jobs.length < batchSize &&
        this.rootNode.visits + jobs.length - weightlessJobs < maxVisits &&
        !timeExceeded()
      ) {
        if (shouldAbort?.()) break;
        attempts++;
        if (attempts > batchSize * 8) break;

        undoMoves.length = 0;
        undoPlayers.length = 0;
        undoSnapshots.length = 0;
        pathMoves.length = 0;
        this.rootHistory?.reset();
        sim.stones.set(this.rootStones);
        sim.koPoint = this.rootKoPoint;
        libertyMapStack[0] = this.rootLibertyMap;
        let depth = 0;

        const path: Node[] = [this.rootNode];
        const edgePath: Edge[] = [];
        let parentGraphH0 = this.rootGraphHash[0]!;
        let parentGraphH1 = this.rootGraphHash[1]!;
        let consecutivePasses = this.rootConsecutivePasses;
        // The path index at which a weightless playout began, or -1. KataGo's
        // countEdgeVisit=false means that edge and every edge above it goes unpaid,
        // so nothing at or above this index is credited with the playout.
        let weightlessFrom = -1;
        let caughtUpEdgeVisits = false;
        let node = this.rootNode;
        let player = this.rootNode.playerToMove;

        while (node.edges && node.edges.length > 0 && depth < MAX_DESCENT_DEPTH) {
          const isRootNode = node === this.rootNode;
          const selection = selectEdge(
            node,
            isRootNode,
            this.wideRootNoise,
            this.rand,
            this.rootEndingBonus,
            this.recentScoreCenter,
            this.forcedRootMoves,
            isRootNode ? this.humanExplore : null,
            depth,
            player === BLACK ? this.avoidMoveUntilBlack : this.avoidMoveUntilWhite
          );
          if (!selection.edge) break;
          let e = selection.edge;
          let countEdgeVisit = selection.countEdgeVisit;

          // KataGo enableMorePassingHacks: once a pass would end the game, make sure
          // the search has looked at both passing and not passing, without letting
          // that look cost the node any weight.
          if (
            ENABLE_MORE_PASSING_HACKS &&
            weightlessFrom < 0 &&
            // KataGo will not force a playout while any move is being avoided, in
            // case the move it would force is one of them.
            this.avoidMoveUntilBlack === null &&
            this.avoidMoveUntilWhite === null &&
            (node !== this.rootNode || this.roiMask === null)
          ) {
            const lastMove =
              pathMoves.length > 0
                ? pathMoves[pathMoves.length - 1]!.move
                : this.rootMoves.length > 0
                  ? this.rootMoves[this.rootMoves.length - 1]!.move
                  : null;
            if (lastMove === PASS_MOVE) {
              let totalChildEdgeVisits = 0;
              let passEdge: Edge | null = null;
              let hasPassChild = false;
              let hasNonPassChild = false;
              let bestNewNonPass: Edge | null = null;
              for (const x of node.edges) {
                if (x.move === PASS_MOVE) passEdge = x;
                if (!x.child) {
                  if (x.move !== PASS_MOVE && (!bestNewNonPass || x.prior > bestNewNonPass.prior)) {
                    bestNewNonPass = x;
                  }
                  continue;
                }
                totalChildEdgeVisits += x.visits;
                if (x.move === PASS_MOVE) hasPassChild = true;
                else hasNonPassChild = true;
              }
              if (totalChildEdgeVisits >= 2) {
                if (!hasPassChild && passEdge && e.move !== PASS_MOVE) {
                  e = passEdge;
                  countEdgeVisit = false;
                } else if (!hasNonPassChild && e.move === PASS_MOVE && bestNewNonPass) {
                  e = bestNewNonPass;
                  countEdgeVisit = false;
                }
              }
            }
          }

          // KataGo maybeCatchUpEdgeVisits: an edge whose child has been visited more
          // often than the edge was paid for can simply pay one back, which is a
          // whole playout without a network call.
          if (countEdgeVisit && e.child && e.visits < e.child.visits) {
            // KataGo adds the edge visit and only then recomputes the node above
            // it, so the parent sees the visit it just paid for. Recomputing first
            // would leave every node's view of its newest child one visit stale.
            e.visits += 1;
            for (let i = path.length - 1; i >= 0; i--) {
              const n = path[i]!;
              n.visits += 1;
              if (i < edgePath.length) edgePath[i]!.visits += 1;
              recomputeNodeStats(n);
            }
            caughtUpEdgeVisits = true;
            break;
          }

          if (!countEdgeVisit) weightlessFrom = path.length - 1;
          edgePath.push(e);
          const move = e.move;

          // The bias key describes the position BEFORE the move, so build it while
          // the simulated board still shows that position.
          const existingChild = e.child;
          const needsBiasKey =
            SUBTREE_VALUE_BIAS_FACTOR !== 0 &&
            (!existingChild || existingChild.biasEpoch !== this.subtreeBiasTable.epoch);
          const biasKey = needsBiasKey
            ? buildSubtreeBiasKey({
                stones: sim.stones,
                libertyMap: libertyMapStack[depth] ?? this.rootLibertyMap,
                move,
                parentMove: pathMoves.length > 0 ? pathMoves[pathMoves.length - 1]!.move : PASS_MOVE,
                koPoint: sim.koPoint,
                pla: player,
              })
            : null;

          const snapshot = playMove(sim, move, player, captureStack, multiStoneSuicideLegal);
          undoMoves.push(move);
          undoPlayers.push(player);
          undoSnapshots.push(snapshot);
          const prevLibertyMap = libertyMapStack[depth] ?? this.rootLibertyMap;
          let nextLibertyMap = libertyMapStack[depth + 1];
          if (!nextLibertyMap) nextLibertyMap = new Uint8Array(BOARD_AREA);
          nextLibertyMap.set(prevLibertyMap);
          const seedCount = buildLibertySeeds({
            move,
            captureStack,
            captureStart: snapshot.captureStart,
            out: libertySeedsScratch,
          });
          if (seedCount > 0) {
            updateLibertyMapForSeeds(sim.stones, libertySeedsScratch, seedCount, nextLibertyMap);
          }
          libertyMapStack[depth + 1] = nextLibertyMap;
          depth++;
          const pathIdx = pathMoves.length;
          const pathPlayer = colorToPlayer(player);
          let pathEntry = pathMoves[pathIdx];
          if (!pathEntry) {
            pathEntry = { move, player: pathPlayer };
            pathMoves[pathIdx] = pathEntry;
          } else {
            pathEntry.move = move;
            pathEntry.player = pathPlayer;
          }
          pathMoves.length = pathIdx + 1;

          // Two passes in a row end the game. Under area scoring the result is then
          // a matter of counting, so the node gets the real score instead of another
          // network guess (KataGo scores such a node as terminal).
          // pathMoves already holds the move just played, so the one before it is
          // either its predecessor on this path or, at the first ply, the last move
          // of the game so far.
          const previousMove =
            pathMoves.length >= 2
              ? pathMoves[pathMoves.length - 2]!.move
              : this.rootMoves.length > 0
                ? this.rootMoves[this.rootMoves.length - 1]!.move
                : null;
          const endsGame = scoreTerminalNodes && move === PASS_MOVE && previousMove === PASS_MOVE;

          const childPlayer = opponentOf(player);
          this.rootHistory?.push(sim.stones, childPlayer);
          consecutivePasses = move === PASS_MOVE ? consecutivePasses + 1 : 0;
          let childGraphH0 = 0;
          let childGraphH1 = 0;
          if (this.useGraphSearch) {
            const scratch = this.graphHashScratch;
            computeStateHash(sim.stones, sim.koPoint, childPlayer, consecutivePasses, scratch);
            if (this.rootHistory) {
              scratch[0] ^= this.rootHistory.hash0;
              scratch[1] ^= this.rootHistory.hash1;
            }
            // KataGo only lets a position stand for itself when no short repetition
            // could come back through the move that made it; otherwise the path's
            // own hash goes in too, and only the identical path matches.
            if (!simpleRepetitionBoundGt(sim.stones, move, GRAPH_SEARCH_REP_BOUND)) {
              mixGraphHash(parentGraphH0, parentGraphH1, scratch[0]!, scratch[1]!, scratch);
            }
            childGraphH0 = scratch[0]!;
            childGraphH1 = scratch[1]!;
          }

          if (!e.child) {
            let attached: Node | null = null;
            if (this.useGraphSearch) {
              const key = packHashKey(childGraphH0, childGraphH1);
              const existing = this.transpositionTable.get(key);
              // An ancestor would close a cycle, which the repetition bound is
              // meant to rule out, but it costs one scan to be certain.
              if (existing && existing.playerToMove === childPlayer && !path.includes(existing)) {
                attached = existing;
                this.transpositionHits++;
              }
              if (!attached) {
                attached = new Node(childPlayer);
                this.transpositionTable.set(key, attached);
              }
            } else {
              attached = new Node(childPlayer);
            }
            e.child = attached;
          }
          if (biasKey !== null && e.child.biasEpoch !== this.subtreeBiasTable.epoch) {
            e.child.biasEntry = this.subtreeBiasTable.get(biasKey);
            e.child.biasEpoch = this.subtreeBiasTable.epoch;
            e.child.lastBiasDeltaSum = 0;
            e.child.lastBiasWeight = 0;
          }
          parentGraphH0 = childGraphH0;
          parentGraphH1 = childGraphH1;
          node = e.child;
          player = node.playerToMove;
          path.push(node);

          if (endsGame && !node.isTerminal && !node.edges) {
            setNodeTerminalEval(node, {
              stones: sim.stones,
              komi: this.komi,
              rules: this.rules,
              recentScoreCenter: this.recentScoreCenter,
            });
          }

          if (!node.edges) break;
        }

        // The playout was spent paying an edge back its visits, so nothing else
        // is owed: unwind and start the next one.
        if (caughtUpEdgeVisits) {
          playouts++;
          for (let i = undoMoves.length - 1; i >= 0; i--) {
            undoMove(sim, undoMoves[i]!, undoPlayers[i]!, undoSnapshots[i]!, captureStack);
          }
          continue;
        }

        // The descent ran into its depth floor without reaching a leaf. Nothing
        // should get here; abandoning the playout beats re-evaluating a node that
        // already has children.
        if (node.edges && node.edges.length > 0) {
          for (let i = undoMoves.length - 1; i >= 0; i--) {
            undoMove(sim, undoMoves[i]!, undoPlayers[i]!, undoSnapshots[i]!, captureStack);
          }
          continue;
        }

        // A finished game needs no evaluation: count the visit and unwind.
        if (node.isTerminal) {
          playouts++;
          for (let i = path.length - 1; i >= 0; i--) {
            if (i <= weightlessFrom) break;
            const n = path[i]!;
            n.visits += 1;
            if (i < edgePath.length) edgePath[i]!.visits += 1;
            recomputeNodeStats(n);
          }
          for (let i = undoMoves.length - 1; i >= 0; i--) {
            undoMove(sim, undoMoves[i]!, undoPlayers[i]!, undoSnapshots[i]!, captureStack);
          }
          continue;
        }

        if (node.pendingEval) {
          for (let i = undoMoves.length - 1; i >= 0; i--) {
            undoMove(sim, undoMoves[i]!, undoPlayers[i]!, undoSnapshots[i]!, captureStack);
          }
          continue;
        }

        node.pendingEval = true;
        for (const n of path) n.inFlight++;

        const jobIdx = jobs.length;
        const leafStones = this.jobStonesScratch.subarray(jobIdx * BOARD_AREA, (jobIdx + 1) * BOARD_AREA);
        leafStones.set(sim.stones);
        const leafKoPoint = sim.koPoint;
        let prevStones = leafStones;
        let prevKoPoint = leafKoPoint;
        let prevPrevStones = leafStones;
        let prevPrevKoPoint = leafKoPoint;
        const leafPlayer = colorToPlayer(player);
        const leafDepth = depth;
        const leafLibertyMap = libertyMapStack[leafDepth] ?? this.rootLibertyMap;
        const superkoBanned = this.rootHistory?.bannedMoves(sim, player, multiStoneSuicideLegal, leafLibertyMap);
        const leafLibertyBuf = this.jobLibertyMapScratch.subarray(jobIdx * BOARD_AREA, (jobIdx + 1) * BOARD_AREA);
        leafLibertyBuf.set(leafLibertyMap);
        let prevLibertyMap: Uint8Array | undefined;
        let prevPrevLibertyMap: Uint8Array | undefined;
        if (leafDepth >= 1) {
          const prevLiberty = libertyMapStack[leafDepth - 1] ?? this.rootLibertyMap;
          const prevLibertyBuf = this.jobPrevLibertyMapScratch.subarray(jobIdx * BOARD_AREA, (jobIdx + 1) * BOARD_AREA);
          prevLibertyBuf.set(prevLiberty);
          prevLibertyMap = prevLibertyBuf;
          if (leafDepth >= 2) {
            const prevPrevLiberty = libertyMapStack[leafDepth - 2];
            if (prevPrevLiberty) {
              const prevPrevLibertyBuf = this.jobPrevPrevLibertyMapScratch.subarray(
                jobIdx * BOARD_AREA,
                (jobIdx + 1) * BOARD_AREA
              );
              prevPrevLibertyBuf.set(prevPrevLiberty);
              prevPrevLibertyMap = prevPrevLibertyBuf;
            }
          } else {
            const prevPrevLibertyBuf = this.jobPrevPrevLibertyMapScratch.subarray(
              jobIdx * BOARD_AREA,
              (jobIdx + 1) * BOARD_AREA
            );
            prevPrevLibertyBuf.set(this.rootPrevLibertyMap);
            prevPrevLibertyMap = prevPrevLibertyBuf;
          }
        }

        if (undoMoves.length >= 1) {
          const lastIdx = undoMoves.length - 1;
          undoMove(sim, undoMoves[lastIdx]!, undoPlayers[lastIdx]!, undoSnapshots[lastIdx]!, captureStack);

          if (lastIdx === 0) {
            // Leaf is a child of the root: prev state is the root, and prev-prev is the pre-root position.
            prevStones = this.rootStones;
            prevKoPoint = this.rootKoPoint;
            prevPrevStones = this.rootPrevStones;
            prevPrevKoPoint = this.rootPrevKoPoint;
          } else {
            const prevBuf = this.jobPrevStonesScratch.subarray(jobIdx * BOARD_AREA, (jobIdx + 1) * BOARD_AREA);
            prevBuf.set(sim.stones);
            prevStones = prevBuf;
            prevKoPoint = sim.koPoint;

            const secondIdx = undoMoves.length - 2;
            undoMove(sim, undoMoves[secondIdx]!, undoPlayers[secondIdx]!, undoSnapshots[secondIdx]!, captureStack);

            if (secondIdx === 0) {
              // Leaf is depth 2: prev-prev is the root.
              prevPrevStones = this.rootStones;
              prevPrevKoPoint = this.rootKoPoint;
            } else {
              const prevPrevBuf = this.jobPrevPrevStonesScratch.subarray(jobIdx * BOARD_AREA, (jobIdx + 1) * BOARD_AREA);
              prevPrevBuf.set(sim.stones);
              prevPrevStones = prevPrevBuf;
              prevPrevKoPoint = sim.koPoint;
            }

            for (let i = secondIdx - 1; i >= 0; i--) {
              undoMove(sim, undoMoves[i]!, undoPlayers[i]!, undoSnapshots[i]!, captureStack);
            }
          }
        }

        const recentMovesScratch = this.jobRecentMovesScratch[jobIdx] ?? (this.jobRecentMovesScratch[jobIdx] = []);
        playouts++;
        if (weightlessFrom >= 0) weightlessJobs++;
        jobs.push({
          leaf: node,
          path,
          edgePath,
          weightlessFrom,
          stones: leafStones,
          koPoint: leafKoPoint,
          libertyMap: leafLibertyBuf,
          superkoBanned,
          prevStones,
          prevKoPoint,
          prevLibertyMap,
          prevPrevStones,
          prevPrevKoPoint,
          prevPrevLibertyMap,
          currentPlayer: leafPlayer,
          recentMoves: takeRecentMoves(this.rootMoves, pathMoves, 5, recentMovesScratch),
          // With pre-root history ignored, only the moves the search itself played
          // reach the history planes: KataGo's maxHistory of depth-below-the-root.
          maxHistory: this.ignorePreRootHistory ? pathMoves.length : 5,
          enablePassingHacks: this.enablePassingHacks,
        });
      }

      if (jobs.length === 0) {
        // A batch can come back empty because every playout ended in a finished
        // game, which needs no evaluation. That is progress, so keep going; only
        // a batch that achieved nothing at all means the search is stuck.
        if (this.rootNode.visits > visitsBeforeBatch) continue;
        break;
      }

      const includeOwnership = this.ownershipMode === 'tree';
      const evals = await evaluateBatch({
        model: this.model,
        includeOwnership,
        rules: this.rules,
        nnRandomize: this.nnRandomize,
        policyOptimism: POLICY_OPTIMISM,
        komi: this.komi,
        playoutDoublingAdvantage: this.playoutDoublingAdvantage,
        playoutDoublingAdvantagePla: this.playoutDoublingAdvantagePla,
        states: jobs,
      });
      timeCheckCounter = 0;

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]!;
        const ev = evals[i]!;

        if (includeOwnership) {
          if (!ev.ownership) throw new Error('Missing ownership output');
          const ownershipSign = job.currentPlayer === 'black' ? 1 : -1;
          const own = new Float32Array(BOARD_AREA);
          const sym = ev.symmetry;
          const symOff = sym * BOARD_AREA;
          const symPosMap = sym === 0 ? null : getSymPosMap();
          for (let p = 0; p < BOARD_AREA; p++) {
            const symPos = sym === 0 ? p : symPosMap![symOff + p]!;
            own[p] = ownershipSign * Math.tanh(ev.ownership[symPos]! * this.outputScaleMultiplier);
          }
          job.leaf.ownership = own;
        }

        expandNode({
          node: job.leaf,
          stones: job.stones,
          koPoint: job.koPoint,
          multiStoneSuicideLegal,
          superkoBanned: job.superkoBanned,
          policyLogits: ev.policy,
          policyLogitsSymmetry: ev.symmetry,
          passLogit: ev.passLogit,
          maxChildren: this.maxChildren,
          libertyMap: ev.libertyMap,
          policyOutputScaling: this.outputScaleMultiplier,
        });

        setNodeOwnEval(job.leaf, ev, this.recentScoreCenter);
        // KataGo recomputes each node on the path from its children after every
        // playout, deepest first, because the reweighting depends on the siblings.
        // A weightless playout stops crediting at the node that asked for it.
        for (let i = job.path.length - 1; i >= 0; i--) {
          const n = job.path[i]!;
          n.inFlight -= 1;
          if (i <= job.weightlessFrom) continue;
          n.visits += 1;
          // The edge this node took has to be paid for before the node is rebuilt
          // from its children, or the node undercounts the child it just visited.
          if (i < job.edgePath.length) job.edgePath[i]!.visits += 1;
          if (n !== job.leaf) recomputeNodeStats(n);
        }
        job.leaf.pendingEval = false;
      }
      if (shouldAbort?.()) return true;
    }
    return shouldAbort?.() ?? false;
  }

  getAnalysis(args: {
    topK: number;
    analysisPvLen: number;
    includeMovesOwnership?: boolean;
    cloneBuffers?: boolean;
    ownershipRefreshIntervalMs?: number;
  }): {
    rootWinRate: number;
    rootScoreLead: number;
    rootScoreSelfplay: number;
    rootScoreStdev: number;
    rootVisits: number;
    /** What the network alone said about the root, before any search. */
    rawWinRate: number;
    rawScoreLead: number;
    rawScoreSelfplay: number;
    rawScoreSelfplayStdev: number;
    rawNoResultProb: number;
    /** -1 when the net is older than model version 10 and does not predict them. */
    rawStWrError: number;
    rawStScoreError: number;
    /** KataGo rawVarTimeLeft. -1 from a net that does not predict it. */
    rawVarTimeLeft: number;
    ownership: FloatArray;
    ownershipStdev: FloatArray;
    policy: FloatArray;
    // Filled in by the worker when a human SL profile was requested.
    humanPolicy?: FloatArray;
    moves: AnalysisPayloadMove[];
  } {
    const topK = Math.max(1, Math.min(args.topK, 50));
    const includeMovesOwnership = args.includeMovesOwnership === true;
    const cloneBuffers = args.cloneBuffers !== false;
    const analysisPvLen = Math.max(0, Math.min(args.analysisPvLen, 60));
    const pvDepth = 1 + analysisPvLen;

    const rows = collectRootCandidateRows(
      this.rootNode,
      this.rootEndingBonus,
      this.recentScoreCenter,
      this.shouldSuppressPass()
    );

    const rootStats = rootNodeStats(this.rootNode);
    const rootWinRate = rootStats.rootWinRate;
    const rootScoreLead = rootStats.rootScoreLead;
    const rootScoreSelfplay = rootStats.rootScoreSelfplay;
    const rootScoreStdev = rootStats.rootScoreStdev;

    const moves = buildAnalysisMoves({
      rows,
      topK,
      pvDepth,
      currentPlayer: this.currentPlayer,
      rootWinRate,
      rootScoreLead,
      includeMovesOwnership,
      cloneBuffers,
      rootSymmetries: this.rootSymmetries,
      roiMask: this.roiMask,
    });

    let ownership: Float32Array;
    let ownershipStdev: Float32Array;
    if (this.ownershipMode === 'tree') {
      const visits = this.rootNode.visits;
      let cached = this.treeOwnershipCache;
      const refreshIntervalMs = args.ownershipRefreshIntervalMs ?? 0;
      const now = getAnimationNow();
      if (!cached) {
        cached = { visits, timestamp: now, ...averageTreeOwnership(this.rootNode) };
        this.treeOwnershipCache = cached;
      } else if (cached.visits !== visits && (refreshIntervalMs <= 0 || now - cached.timestamp >= refreshIntervalMs)) {
        cached = { visits, timestamp: now, ...averageTreeOwnership(this.rootNode) };
        this.treeOwnershipCache = cached;
      }
      ownership = cloneBuffers ? new Float32Array(cached.ownership) : cached.ownership;
      ownershipStdev = cloneBuffers ? new Float32Array(cached.ownershipStdev) : cached.ownershipStdev;
    } else {
      ownership = cloneBuffers ? new Float32Array(this.rootOwnership) : this.rootOwnership;
      ownershipStdev = new Float32Array(BOARD_AREA);
    }
    const policyOut = cloneBuffers ? new Float32Array(this.rootPolicy) : this.rootPolicy;

    return {
      rootWinRate,
      rootScoreLead,
      rootScoreSelfplay,
      rootScoreStdev,
      rootVisits: this.rootNode.visits,
      rawWinRate: this.rootRaw.winRate,
      rawScoreLead: this.rootRaw.scoreLead,
      rawScoreSelfplay: this.rootRaw.scoreSelfplay,
      rawScoreSelfplayStdev: this.rootRaw.scoreSelfplayStdev,
      rawNoResultProb: this.rootRaw.noResultProb,
      rawStWrError: this.rootRaw.stWrError,
      rawStScoreError: this.rootRaw.stScoreError,
      rawVarTimeLeft: this.rootRaw.varTimeLeft,
      ownership,
      ownershipStdev,
      policy: policyOut,
      moves,
    };
  }
}
