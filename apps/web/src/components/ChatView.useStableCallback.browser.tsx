import { useEffect, useLayoutEffect } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useStableCallback } from "../hooks/useStableCallback";

function Probe(props: { label: string; onReady: (callback: () => string) => void }) {
  const read = useStableCallback(() => props.label);
  const { onReady } = props;
  useEffect(() => {
    onReady(read);
  }, [onReady, read]);
  return <span>{props.label}</span>;
}

describe("useStableCallback", () => {
  it("keeps one identity across renders and calls the latest closure", async () => {
    const seen: Array<() => string> = [];
    const onReady = (callback: () => string) => {
      seen.push(callback);
    };
    const screen = await render(<Probe label="first" onReady={onReady} />);
    await screen.rerender(<Probe label="second" onReady={onReady} />);
    await expect.element(screen.getByText("second")).toBeInTheDocument();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.()).toBe("second");
  });
});

function LayoutEffectChild(props: {
  label: string;
  read: () => string;
  onLayout: (value: string) => void;
}) {
  const { read, onLayout } = props;
  useLayoutEffect(() => {
    onLayout(read());
  });
  // Rendering the label makes the child re-render with the parent, so its layout effect reruns.
  return <span>{props.label}</span>;
}

function LayoutEffectParent(props: { label: string; onLayout: (value: string) => void }) {
  const read = useStableCallback(() => props.label);
  return <LayoutEffectChild label={props.label} read={read} onLayout={props.onLayout} />;
}

describe("useStableCallback in child layout effects", () => {
  it("sees the latest closure from a child's layout effect in the same commit", async () => {
    const seen: string[] = [];
    const onLayout = (value: string) => {
      seen.push(value);
    };
    const screen = await render(<LayoutEffectParent label="first" onLayout={onLayout} />);
    await screen.rerender(<LayoutEffectParent label="second" onLayout={onLayout} />);
    await expect.element(screen.getByText("second")).toBeInTheDocument();

    expect(seen).toEqual(["first", "second"]);
  });
});
