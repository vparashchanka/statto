"use server";

import { auth0 } from "@/lib/auth0";
import { redirect } from "next/navigation";
import { after } from "next/server";
import {
  insertMatch,
  updateMatchStatus,
  updateMatchComment,
  insertMatchPlayers,
  findMatchPlayers,
  findMatchById,
  findGamesByMatchId,
  findScoresByGameIds,
  findMarksByGameIds
} from "../repository/matches.repository";
import { generateMatchComment } from "@/lib/services/openai.service";
import { dispatchNotifications } from "@/features/notifications";
import { findGroupById } from "@/features/groups/repository/groups.repository";

export async function createMatch(groupId: number): Promise<number> {
  const session = await auth0.getSession();
  if (!session?.user) {
    redirect("/auth/login");
  }

  return insertMatch(groupId);
}

export async function startMatch(matchId: number): Promise<void> {
  const session = await auth0.getSession();
  if (!session?.user) {
    redirect("/auth/login");
  }

  const now = new Date();
  await updateMatchStatus(matchId, {
    status: "in_progress",
    startedAt: now,
    duration: 0,
    timerStartedAt: now,
  });
}

export async function pauseMatch(matchId: number): Promise<void> {
  const session = await auth0.getSession();
  if (!session?.user) {
    redirect("/auth/login");
  }

  const match = await findMatchById(matchId);
  if (!match || match.status !== "in_progress") return;

  // Add the current running-segment to the stored duration
  const segmentSeconds = match.timerStartedAt
    ? Math.floor((Date.now() - match.timerStartedAt.getTime()) / 1000)
    : 0;

  await updateMatchStatus(matchId, {
    status: "paused",
    duration: (match.duration ?? 0) + segmentSeconds,
    timerStartedAt: null,
  });
}

export async function resumeMatch(matchId: number): Promise<void> {
  const session = await auth0.getSession();
  if (!session?.user) {
    redirect("/auth/login");
  }

  const match = await findMatchById(matchId);
  if (!match || match.status !== "paused") return;

  await updateMatchStatus(matchId, {
    status: "in_progress",
    timerStartedAt: new Date(),
  });
}

export async function completeMatch(
  matchId: number,
  comment?: string | null
): Promise<void> {
  const session = await auth0.getSession();
  if (!session?.user) {
    redirect("/auth/login");
  }

  const match = await findMatchById(matchId);

  // Flush any running segment into duration before completing
  const segmentSeconds =
    match?.timerStartedAt
      ? Math.floor((Date.now() - match.timerStartedAt.getTime()) / 1000)
      : 0;

  const finalDuration = (match?.duration ?? 0) + segmentSeconds;

  await updateMatchStatus(matchId, {
    status: "done",
    finishedAt: new Date(),
    duration: finalDuration,
    timerStartedAt: null,
    comment: comment?.trim() || null,
  });

  // Fire notifications after the response is sent. `after()` keeps the serverless
  // function alive until the work finishes — a bare un-awaited promise gets frozen
  // as soon as the action returns, so messages were dropped intermittently.
  if (match?.groupId) {
    const groupId = match.groupId;
    console.log(
      `[completeMatch] matchId=${matchId} groupId=${groupId} duration=${finalDuration} — dispatching notifications`,
    );
    after(() =>
      fireMatchNotifications(matchId, groupId, finalDuration, comment?.trim() || null).catch((err) =>
        console.error(`[completeMatch] matchId=${matchId} groupId=${groupId} notification dispatch error:`, err),
      ),
    );
  } else {
    console.warn(`[completeMatch] matchId=${matchId} has no groupId — skipping notification dispatch`);
  }
}

export async function saveMatchComment(
  matchId: number,
  comment: string | null
): Promise<void> {
  const session = await auth0.getSession();
  if (!session?.user) {
    redirect("/auth/login");
  }

  await updateMatchComment(matchId, comment?.trim() || null);
}

export async function generateAIMatchComment(matchId: number): Promise<string> {
  const session = await auth0.getSession();
  if (!session?.user) {
    redirect("/auth/login");
  }

  // Get match details
  const matchPlayers = await findMatchPlayers(matchId);
  const games = await findGamesByMatchId(matchId);

  // Get game details
  const gameIds = games.map(game => game.id);
  const allScores = gameIds.length > 0 ? await findScoresByGameIds(gameIds) : [];
  const allMarks = gameIds.length > 0 ? await findMarksByGameIds(gameIds) : [];

  // Organize data for the OpenAI prompt
  const gameDetails = games.map(game => {
    return {
      comment: game.comment,
      scores: allScores.filter(score => score.gameId === game.id),
      marks: allMarks.filter(mark => mark.gameId === game.id)
    };
  });

  // Generate comment
  const generatedComment = await generateMatchComment({
    players: matchPlayers,
    games: gameDetails,
    matchStatus: "completed",
  });

  // Save the generated comment
  await updateMatchComment(matchId, generatedComment);

  return generatedComment;
}

export async function uncompleteMatch(matchId: number): Promise<void> {
  const session = await auth0.getSession();
  if (!session?.user) {
    redirect("/auth/login");
  }

  // Resume the timer from where it was left off
  await updateMatchStatus(matchId, {
    status: "in_progress",
    finishedAt: null,
    timerStartedAt: new Date(),
  });
}

export async function addPlayersToMatch(
  matchId: number,
  playerIds: number[]
): Promise<void> {
  if (playerIds.length === 0) return;
  await insertMatchPlayers(matchId, playerIds);
}

export type MatchPlayer = {
  id: number;
  nickname: string;
};

export async function getMatchPlayers(matchId: number): Promise<MatchPlayer[]> {
  return findMatchPlayers(matchId);
}

// ── Notification helper (private) ──────────────────────

async function fireMatchNotifications(
  matchId: number,
  groupId: number,
  duration: number,
  comment: string | null,
): Promise<void> {
  console.log(`[fireMatchNotifications] matchId=${matchId} groupId=${groupId} — collecting data`);

  const [group, matchPlayers, games] = await Promise.all([
    findGroupById(groupId),
    findMatchPlayers(matchId),
    findGamesByMatchId(matchId),
  ]);

  console.log(
    `[fireMatchNotifications] matchId=${matchId} groupId=${groupId} — group=${group ? group.name : 'null'} ` +
      `matchPlayers=${matchPlayers.length} games=${games.length}`,
  );

  if (!group) {
    console.error(
      `[fireMatchNotifications] matchId=${matchId} groupId=${groupId} — group not found, aborting notification dispatch`,
    );
    return;
  }

  if (matchPlayers.length === 0) {
    console.warn(`[fireMatchNotifications] matchId=${matchId} groupId=${groupId} — no match players found`);
  }
  if (games.length === 0) {
    console.warn(`[fireMatchNotifications] matchId=${matchId} groupId=${groupId} — no games found`);
  }

  const gameIds = games.map((g) => g.id);
  const allScores = gameIds.length > 0 ? await findScoresByGameIds(gameIds) : [];

  console.log(
    `[fireMatchNotifications] matchId=${matchId} groupId=${groupId} — gameIds=${gameIds.length} scores=${allScores.length}`,
  );

  // Compute wins per player
  const winsMap = new Map<number, { nickname: string; wins: number }>();
  for (const p of matchPlayers) {
    winsMap.set(p.id, { nickname: p.nickname, wins: 0 });
  }

  for (const game of games) {
    const scores = allScores.filter((s) => s.gameId === game.id);
    if (scores.length < 2) continue;
    const maxScore = Math.max(...scores.map((s) => s.score));
    const winners = scores.filter((s) => s.score === maxScore);
    if (winners.length < scores.length) {
      for (const w of winners) {
        const entry = winsMap.get(w.playerId);
        if (entry) entry.wins++;
      }
    }
  }

  const sorted = Array.from(winsMap.entries())
    .map(([, { nickname, wins }]) => ({ playerName: nickname, wins }))
    .sort((a, b) => b.wins - a.wins);

  const hasWinner = sorted.length >= 2 && sorted[0].wins > sorted[1].wins && sorted[0].wins > 0;

  const results = sorted.map((p, idx) => ({
    playerName: p.playerName,
    wins: p.wins,
    isWinner: hasWinner && idx === 0,
  }));

  console.log(
    `[fireMatchNotifications] matchId=${matchId} groupId=${groupId} — results=${JSON.stringify(results)} ` +
      `hasWinner=${hasWinner}`,
  );

  try {
    await dispatchNotifications(groupId, {
      groupName: group.name,
      matchId,
      groupId,
      results,
      comment,
      duration,
      appBaseUrl: process.env.APP_BASE_URL,
    });
    console.log(`[fireMatchNotifications] matchId=${matchId} groupId=${groupId} — dispatchNotifications completed`);
  } catch (err) {
    console.error(`[fireMatchNotifications] matchId=${matchId} groupId=${groupId} — dispatchNotifications threw:`, err);
    throw err;
  }
}
