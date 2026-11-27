import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { InlineCell } from "../src/components.tsx";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("double-click edit saves once on Enter even when blur follows", async () => {
  const calls: string[] = [];
  let tree: any;
  await act(async () => {
    tree = create(
      React.createElement(InlineCell, {
        value: "旧名称",
        onSave: async (v: string) => {
          calls.push(v);
        },
      }),
    );
  });
  await act(async () => {
    tree.root.findByProps({ className: "editable " }).props.onDoubleClick();
  });
  await act(async () => {
    tree.root
      .findByType("input")
      .props.onChange({ target: { value: "新名称" } });
  });
  const props = tree.root.findByType("input").props;
  await act(async () => {
    props.onKeyDown({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
    props.onBlur();
  });
  assert.deepEqual(calls, ["新名称"]);
  assert.equal(tree.root.findAllByType("input").length, 0);
  await act(async () => tree.unmount());
});
test("Escape cancels without saving, and IME composition does not save", async () => {
  let saved = 0,
    tree: any;
  await act(async () => {
    tree = create(
      React.createElement(InlineCell, {
        value: "原始",
        onSave: async () => {
          saved++;
        },
      }),
    );
  });
  await act(async () => {
    tree.root.findByProps({ className: "editable " }).props.onDoubleClick();
  });
  await act(async () => {
    tree.root
      .findByType("input")
      .props.onChange({ target: { value: "编辑中" } });
  });
  const props = tree.root.findByType("input").props;
  await act(async () => {
    props.onKeyDown({
      key: "Enter",
      nativeEvent: { isComposing: true },
      preventDefault() {},
    });
  });
  assert.equal(saved, 0);
  await act(async () => {
    props.onKeyDown({
      key: "Escape",
      preventDefault() {},
      stopPropagation() {},
    });
    props.onBlur();
  });
  assert.equal(saved, 0);
  assert.equal(tree.root.findAllByType("input").length, 0);
  await act(async () => tree.unmount());
});
test("failed saves retain edited input with a retry action", async () => {
  let tree: any;
  await act(async () => {
    tree = create(
      React.createElement(InlineCell, {
        value: "原始",
        onSave: async () => {
          throw new Error("云端连接暂时不可用");
        },
      }),
    );
  });
  await act(async () => {
    tree.root.findByProps({ className: "editable " }).props.onDoubleClick();
  });
  await act(async () => {
    tree.root
      .findByType("input")
      .props.onChange({ target: { value: "保留此内容" } });
  });
  await act(async () => {
    await tree.root.findByType("input").props.onBlur();
  });
  assert.equal(tree.root.findByType("input").props.value, "保留此内容");
  assert.equal(tree.root.findByType("small").children[0], "云端连接暂时不可用");
  assert.ok(tree.root.findAllByType("button").length);
  await act(async () => tree.unmount());
});
