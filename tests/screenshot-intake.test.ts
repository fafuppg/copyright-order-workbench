import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { ImageViewer } from "../src/components.tsx";
import { TaskFields } from "../src/Tasks.tsx";
import { parseExtraction } from "../server/ai.ts";
import { manualScreenshotChoices } from "../shared/screenshot-intake.ts";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("screenshot extraction ignores inferred type and preserves factual old and new names", () => {
  const result = parseExtraction(
    JSON.stringify({
      customer: {},
      items: [
        {
          kind: "correction",
          parentId: "guessed",
          softwareName: "新名称",
          originalName: "旧名称",
        },
      ],
    }),
  );
  assert.equal(result.items[0].kind, "new");
  assert.equal(result.items[0].originalName, "旧名称");
  assert.equal("parentId" in result.items[0], false);
});
test("screenshot proposals discard inferred workflow choices but preserve an existing manual selection", () => {
  const input = {
    customerId: "guessed",
    items: [
      {
        softwareName: "名称",
        kind: "correction",
        parentId: "guessed",
        needsSubmission: true,
      },
    ],
  };
  assert.deepEqual(manualScreenshotChoices(input), {
    items: [
      {
        softwareName: "名称",
        kind: "new",
        parentId: null,
        needsSubmission: false,
      },
    ],
  });
  const prior = {
    customerId: "chosen-customer",
    items: [
      {
        softwareName: "名称",
        kind: "correction",
        parentId: "chosen-parent",
        needsSubmission: true,
      },
    ],
  };
  const next = manualScreenshotChoices(input, prior);
  assert.equal(next.customerId, "chosen-customer");
  assert.equal(next.items[0].parentId, "chosen-parent");
  assert.equal(next.items[0].kind, "correction");
  assert.equal(input.customerId, "guessed");
});
test("screenshot viewer starts fitted and resets to the whole image when changing sources", async () => {
  let tree: any;
  await act(async () => {
    tree = create(React.createElement(ImageViewer, { ids: ["one", "two"] }));
  });
  const stage = () =>
    tree.root
      .findAllByType("div")
      .find((n: any) => String(n.props.className).startsWith("image-scroll"));
  assert.match(stage().props.className, /fit-image/);
  const button = (text: string) =>
    tree.root
      .findAllByType("button")
      .find((n: any) => n.children.includes(text));
  await act(async () => button("适合宽度").props.onClick());
  assert.doesNotMatch(stage().props.className, /fit-image/);
  await act(async () =>
    tree.root
      .findByProps({ className: "thumbs" })
      .findAllByType("button")[1]
      .props.onClick(),
  );
  assert.match(stage().props.className, /fit-image/);
  assert.equal(stage().findByType("img").props.src, "/api/v1/screenshots/two");
  await act(async () => button("适合宽度").props.onClick());
  await act(async () => button("适应窗口").props.onClick());
  assert.match(stage().props.className, /fit-image/);
  await act(async () => tree.unmount());
});
test("task type uses explicit radio selection and clears the original-order link when choosing new", async () => {
  let tree: any, chosen: any;
  await act(async () => {
    tree = create(
      React.createElement(TaskFields, {
        value: { kind: "correction", parentId: "old", softwareName: "软件" },
        onChange: (v) => {
          chosen = v;
        },
      }),
    );
  });
  const radios = tree.root.findAllByProps({ type: "radio" });
  assert.equal(radios.length, 2);
  assert.equal(radios[1].props.checked, true);
  await act(async () => radios[0].props.onChange());
  assert.equal(chosen.kind, "new");
  assert.equal(chosen.parentId, null);
  await act(async () => tree.unmount());
});
