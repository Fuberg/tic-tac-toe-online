// Shared between lobby.tsx (bot list) and match.tsx (opponent label) so the two client
// components don't each define their own copy of the same three Russian labels.
export type BotDifficulty = "easy" | "medium" | "hard";

// CONTEXT.md's Bot glossary entry: ровно три фиксированных уровня сложности.
export const DIFFICULTY_LABEL: Record<BotDifficulty, string> = {
  easy: "Лёгкий",
  medium: "Средний",
  hard: "Сложный",
};
