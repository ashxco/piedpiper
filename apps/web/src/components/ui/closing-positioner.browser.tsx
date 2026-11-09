import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { renderClosingPositioner } from "./closing-positioner";

function Positioner(props: { open: boolean; left: number; opacity: number }) {
  return renderClosingPositioner(
    {
      "data-testid": "positioner",
      style: { position: "absolute", left: props.left, top: 10, opacity: props.opacity },
    } as ComponentProps<"div">,
    { open: props.open },
  );
}

describe("renderClosingPositioner", () => {
  it("follows placement while open and freezes it while closing", async () => {
    const screen = await render(<Positioner open left={10} opacity={1} />);
    const element = () => screen.getByTestId("positioner").element() as HTMLElement;
    expect(element().style.left).toBe("10px");

    await screen.rerender(<Positioner open left={40} opacity={1} />);
    expect(element().style.left).toBe("40px");

    await screen.rerender(<Positioner open={false} left={90} opacity={0.5} />);
    expect(element().style.left).toBe("40px");
    expect(element().style.opacity).toBe("0.5");

    await screen.rerender(<Positioner open left={90} opacity={1} />);
    expect(element().style.left).toBe("90px");
  });
});
