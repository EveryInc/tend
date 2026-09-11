import { expect, test } from "bun:test";
import { COMPOSE_CARD_PROMPT } from "../server/templates";

test("card composition prompt distinguishes local dismissal from source cleanup", () => {
  expect(COMPOSE_CARD_PROMPT).toContain("`dismiss_card`");
  expect(COMPOSE_CARD_PROMPT).toContain("without creating work or mutating its source");
  expect(COMPOSE_CARD_PROMPT).toContain("explicit source cleanup");
  expect(COMPOSE_CARD_PROMPT).toContain("routine “clear this card” control");
});
