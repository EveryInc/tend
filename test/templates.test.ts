import { expect, test } from "bun:test";
import { BASE_JUDGE_PROMPT, COMPOSE_CARD_PROMPT } from "../server/templates";

test("card composition prompt distinguishes local dismissal from source cleanup", () => {
  expect(COMPOSE_CARD_PROMPT).toContain("`dismiss_card`");
  expect(COMPOSE_CARD_PROMPT).toContain("without creating work or mutating its source");
  expect(COMPOSE_CARD_PROMPT).toContain("explicit source cleanup");
  expect(COMPOSE_CARD_PROMPT).toContain("routine “clear this card” control");
});

test("the judge prompt tells agents to name each judgment's card and reuse it", () => {
  expect(BASE_JUDGE_PROMPT).toContain("stable `cardId`");
  expect(BASE_JUDGE_PROMPT).toContain("reuse that exact id in `card:upsert`");
  expect(BASE_JUDGE_PROMPT).toContain("before the source\ncheckpoint advances");
});
