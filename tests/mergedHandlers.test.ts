import { assertEquals } from "@std/assert";
import {
  extractHandlerNames,
  runHandlerAttribute,
} from "../client/handlerAttribute.ts";
import {
  type GlobalPlusHandlers,
  handlersRuntimeReady,
} from "../client/eventHandlers.ts";

void handlersRuntimeReady;

Deno.test("multi-handlers begin independently", async () => {
  const calls: string[] = [];
  const handlers = (globalThis as GlobalPlusHandlers).handlers;
  const firstDone = Promise.withResolvers<void>();
  const secondDone = Promise.withResolvers<void>();
  handlers.first = async () => {
    calls.push("first:start");
    await firstDone.promise;
    calls.push("first:end");
  };
  handlers.second = async () => {
    calls.push("second:start");
    await secondDone.promise;
    calls.push("second:end");
  };

  const running = runHandlerAttribute(
    {},
    new Event("mount"),
    "handlers.first.call(this, event);handlers.second.call(this, event)",
  );

  assertEquals(calls, ["first:start", "second:start"]);
  secondDone.resolve();
  await Promise.resolve();
  firstDone.resolve();
  await running;
  assertEquals(calls, [
    "first:start",
    "second:start",
    "second:end",
    "first:end",
  ]);
});

Deno.test("synchronous merged handlers execute in order and stop after false", async () => {
  const calls: string[] = [];
  const handlers = (globalThis as GlobalPlusHandlers).handlers;
  handlers.first = async () => {
    await Promise.resolve();
    calls.push("first");
  };
  handlers.second = () => {
    calls.push("second");
    return false;
  };
  handlers.third = () => {
    calls.push("third");
  };

  const result = await runHandlerAttribute(
    {},
    new Event("mount"),
    "void (async()=>{if(await handlers.first.call(this, event)===false)return;if(await handlers.second.call(this, event)===false)return;if(await handlers.third.call(this, event)===false)return;})()",
  );

  assertEquals(result, false);
  assertEquals(calls, ["first", "second"]);
});

Deno.test("multi-handler attributes retain all concrete handler names", () => {
  const attribute =
    "handlers.partialRouteCache_123.call(this, event);handlers.partialReplace_456.call(this, event)";

  assertEquals(extractHandlerNames(attribute), [
    "partialRouteCache_123",
    "partialReplace_456",
  ]);
});
