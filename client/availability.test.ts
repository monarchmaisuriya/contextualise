import { expect, test, vi } from "vitest";
import { followAvailability } from "./availability";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const answers: ((wanted: boolean) => void)[] = [];
  const check = vi.fn(() => new Promise<boolean>((resolve) => answers.push(resolve)));
  const remove = vi.fn();
  const register = vi.fn(() => remove);
  const follower = followAvailability(check, register, () => {});
  return { answers, check, register, remove, follower };
}

test("registers while wanted and removes once not", async () => {
  const { answers, register, remove, follower } = setup();
  follower.refresh();
  answers[0](true);
  await settle();
  expect(register).toHaveBeenCalledTimes(1);
  follower.refresh();
  await settle();
  answers[1](false);
  await settle();
  expect(remove).toHaveBeenCalledTimes(1);
});

test("runs one check at a time and applies the newest answer last", async () => {
  const { answers, register, remove, follower } = setup();
  follower.refresh();
  // Asked again while the first check runs, for example right after the last project was detached.
  follower.refresh();
  follower.refresh();
  expect(answers).toHaveLength(1);
  answers[0](true);
  await settle();
  expect(answers).toHaveLength(2);
  answers[1](false);
  await settle();
  expect(register).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(answers).toHaveLength(2);
});

test("adds nothing once stopped, and removes what it added", async () => {
  const { answers, register, remove, follower } = setup();
  follower.refresh();
  answers[0](true);
  await settle();
  follower.stop();
  expect(remove).toHaveBeenCalledTimes(1);
  const late = setup();
  late.follower.refresh();
  late.follower.stop();
  late.answers[0](true);
  await settle();
  expect(late.register).not.toHaveBeenCalled();
  expect(register).toHaveBeenCalledTimes(1);
});
