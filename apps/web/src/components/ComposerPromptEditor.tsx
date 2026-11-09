import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $applyNodeReplacement,
  $createRangeSelection,
  $createRangeSelectionFromDom,
  $getSelection,
  $setSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  KEY_BACKSPACE_COMMAND,
  BLUR_COMMAND,
  FOCUS_COMMAND,
  $getRoot,
  HISTORY_MERGE_TAG,
  DecoratorNode,
  type ElementNode,
  type LexicalNode,
  type SerializedLexicalNode,
  TextNode,
  type EditorConfig,
  type EditorState,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ClipboardEventHandler,
  type ReactElement,
  type Ref,
} from "react";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
  isCollapsedCursorAdjacentToInlineToken,
  resolveComposerLineBoundaryMove,
} from "~/composer-logic";
import {
  selectionTouchesMentionBoundary,
  serializeComposerMentionPath,
  splitPromptIntoComposerSegments,
} from "~/composer-editor-mentions";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { isImeComposingKeyboardEvent } from "~/lib/imeComposition";
import { basenameOfPath, getVscodeIconUrlForEntry, inferEntryKindFromPath } from "~/vscode-icons";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_SELECTION_CLASS_NAME,
} from "./composerInlineChip";
import { ComposerPendingTerminalContextChip } from "./chat/ComposerPendingTerminalContexts";
import {
  type ComposerPageScrollDirection,
  resolveComposerPageScrollDirection,
} from "./chat/composerPageScrollKeys";

const COMPOSER_EDITOR_HMR_KEY = `composer-editor-${Math.random().toString(36).slice(2)}`;

type SerializedComposerMentionNode = Spread<
  {
    path: string;
    type: "composer-mention";
    version: 1;
  },
  SerializedTextNode
>;

type SerializedComposerTerminalContextNode = Spread<
  {
    context: TerminalContextDraft;
    type: "composer-terminal-context";
    version: 1;
  },
  SerializedLexicalNode
>;

const ComposerTerminalContextActionsContext = createContext<{
  onRemoveTerminalContext: (contextId: string) => void;
}>({
  onRemoveTerminalContext: () => {},
});

class ComposerMentionNode extends TextNode {
  __path: string;

  static override getType(): string {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(node.__path, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerMentionNode): ComposerMentionNode {
    return $createComposerMentionNode(serializedNode.path);
  }

  constructor(path: string, key?: NodeKey) {
    super(`@${serializeComposerMentionPath(path)}`, key);
    this.__path = path;
  }

  override exportJSON(): SerializedComposerMentionNode {
    return {
      ...super.exportJSON(),
      path: this.__path,
      type: "composer-mention",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className = `${COMPOSER_INLINE_CHIP_CLASS_NAME} ${COMPOSER_INLINE_CHIP_SELECTION_CLASS_NAME}`;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    renderMentionChipDom(dom, this.__path);
    return dom;
  }

  override updateDOM(
    prevNode: ComposerMentionNode,
    dom: HTMLElement,
    _config: EditorConfig,
  ): boolean {
    dom.contentEditable = "false";
    if (prevNode.__text !== this.__text || prevNode.__path !== this.__path) {
      renderMentionChipDom(dom, this.__path);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

function $createComposerMentionNode(path: string): ComposerMentionNode {
  return $applyNodeReplacement(new ComposerMentionNode(path));
}

function ComposerTerminalContextDecorator(props: { context: TerminalContextDraft }) {
  return <ComposerPendingTerminalContextChip context={props.context} />;
}

class ComposerTerminalContextNode extends DecoratorNode<ReactElement> {
  __context: TerminalContextDraft;

  static override getType(): string {
    return "composer-terminal-context";
  }

  static override clone(node: ComposerTerminalContextNode): ComposerTerminalContextNode {
    return new ComposerTerminalContextNode(node.__context, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedComposerTerminalContextNode,
  ): ComposerTerminalContextNode {
    return $createComposerTerminalContextNode(serializedNode.context);
  }

  constructor(context: TerminalContextDraft, key?: NodeKey) {
    super(key);
    this.__context = context;
  }

  override exportJSON(): SerializedComposerTerminalContextNode {
    return {
      ...super.exportJSON(),
      context: this.__context,
      type: "composer-terminal-context",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = `inline-flex align-middle leading-none ${COMPOSER_INLINE_CHIP_SELECTION_CLASS_NAME}`;
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): ReactElement {
    return <ComposerTerminalContextDecorator context={this.__context} />;
  }
}

function $createComposerTerminalContextNode(
  context: TerminalContextDraft,
): ComposerTerminalContextNode {
  return $applyNodeReplacement(new ComposerTerminalContextNode(context));
}

type ComposerInlineTokenNode = ComposerMentionNode | ComposerTerminalContextNode;

function isComposerInlineTokenNode(candidate: unknown): candidate is ComposerInlineTokenNode {
  return (
    candidate instanceof ComposerMentionNode || candidate instanceof ComposerTerminalContextNode
  );
}

function resolvedThemeFromDocument(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function renderMentionChipDom(container: HTMLElement, pathValue: string): void {
  container.textContent = "";
  container.title = pathValue;
  container.style.setProperty("user-select", "none");
  container.style.setProperty("-webkit-user-select", "none");

  const theme = resolvedThemeFromDocument();
  const icon = document.createElement("img");
  icon.alt = "";
  icon.ariaHidden = "true";
  icon.className = COMPOSER_INLINE_CHIP_ICON_CLASS_NAME;
  icon.loading = "lazy";
  icon.src = getVscodeIconUrlForEntry(pathValue, inferEntryKindFromPath(pathValue), theme);

  const label = document.createElement("span");
  label.className = COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME;
  label.textContent = basenameOfPath(pathValue);

  container.append(icon, label);
}

function terminalContextSignature(contexts: ReadonlyArray<TerminalContextDraft>): string {
  return contexts
    .map((context) =>
      [
        context.id,
        context.threadId,
        context.terminalId,
        context.terminalLabel,
        context.lineStart,
        context.lineEnd,
        context.createdAt,
        context.text,
      ].join("\u001f"),
    )
    .join("\u001e");
}

function clampExpandedCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.max(0, Math.min(value.length, Math.floor(cursor)));
}

function getComposerInlineTokenTextLength(_node: ComposerInlineTokenNode): 1 {
  return 1;
}

function getComposerInlineTokenExpandedTextLength(node: ComposerInlineTokenNode): number {
  return node.getTextContentSize();
}

function getAbsoluteOffsetForInlineTokenPoint(
  node: ComposerInlineTokenNode,
  absoluteOffset: number,
  pointOffset: number,
): number {
  return absoluteOffset + (pointOffset > 0 ? getComposerInlineTokenTextLength(node) : 0);
}

function getExpandedAbsoluteOffsetForInlineTokenPoint(
  node: ComposerInlineTokenNode,
  absoluteOffset: number,
  pointOffset: number,
): number {
  return absoluteOffset + (pointOffset > 0 ? getComposerInlineTokenExpandedTextLength(node) : 0);
}

function findSelectionPointForInlineToken(
  node: ComposerInlineTokenNode,
  remainingRef: { value: number },
): { key: string; offset: number; type: "element" } | null {
  const parent = node.getParent();
  if (!parent || !$isElementNode(parent)) return null;
  const index = node.getIndexWithinParent();
  if (remainingRef.value === 0) {
    return {
      key: parent.getKey(),
      offset: index,
      type: "element",
    };
  }
  if (remainingRef.value === getComposerInlineTokenTextLength(node)) {
    return {
      key: parent.getKey(),
      offset: index + 1,
      type: "element",
    };
  }
  remainingRef.value -= getComposerInlineTokenTextLength(node);
  return null;
}

function getComposerNodeTextLength(node: LexicalNode): number {
  if (isComposerInlineTokenNode(node)) {
    return getComposerInlineTokenTextLength(node);
  }
  if ($isTextNode(node)) {
    return node.getTextContentSize();
  }
  if ($isLineBreakNode(node)) {
    return 1;
  }
  if ($isElementNode(node)) {
    return node.getChildren().reduce((total, child) => total + getComposerNodeTextLength(child), 0);
  }
  return 0;
}

function getComposerNodeExpandedTextLength(node: LexicalNode): number {
  if (isComposerInlineTokenNode(node)) {
    return getComposerInlineTokenExpandedTextLength(node);
  }
  if ($isTextNode(node)) {
    return node.getTextContentSize();
  }
  if ($isLineBreakNode(node)) {
    return 1;
  }
  if ($isElementNode(node)) {
    return node
      .getChildren()
      .reduce((total, child) => total + getComposerNodeExpandedTextLength(child), 0);
  }
  return 0;
}

function getAbsoluteOffsetForPoint(node: LexicalNode, pointOffset: number): number {
  let offset = 0;
  let current: LexicalNode | null = node;

  while (current) {
    const nextParent = current.getParent() as LexicalNode | null;
    if (!nextParent || !$isElementNode(nextParent)) {
      break;
    }
    const siblings = nextParent.getChildren();
    const index = current.getIndexWithinParent();
    for (let i = 0; i < index; i += 1) {
      const sibling = siblings[i];
      if (!sibling) continue;
      offset += getComposerNodeTextLength(sibling);
    }
    current = nextParent;
  }

  if ($isTextNode(node)) {
    if (node instanceof ComposerMentionNode) {
      return getAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
    }
    return offset + Math.min(pointOffset, node.getTextContentSize());
  }
  if (node instanceof ComposerTerminalContextNode) {
    return getAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
  }

  if ($isLineBreakNode(node)) {
    return offset + Math.min(pointOffset, 1);
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    const clampedOffset = Math.max(0, Math.min(pointOffset, children.length));
    for (let i = 0; i < clampedOffset; i += 1) {
      const child = children[i];
      if (!child) continue;
      offset += getComposerNodeTextLength(child);
    }
    return offset;
  }

  return offset;
}

function getExpandedAbsoluteOffsetForPoint(node: LexicalNode, pointOffset: number): number {
  let offset = 0;
  let current: LexicalNode | null = node;

  while (current) {
    const nextParent = current.getParent() as LexicalNode | null;
    if (!nextParent || !$isElementNode(nextParent)) {
      break;
    }
    const siblings = nextParent.getChildren();
    const index = current.getIndexWithinParent();
    for (let i = 0; i < index; i += 1) {
      const sibling = siblings[i];
      if (!sibling) continue;
      offset += getComposerNodeExpandedTextLength(sibling);
    }
    current = nextParent;
  }

  if ($isTextNode(node)) {
    if (node instanceof ComposerMentionNode) {
      return getExpandedAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
    }
    return offset + Math.min(pointOffset, node.getTextContentSize());
  }
  if (node instanceof ComposerTerminalContextNode) {
    return getExpandedAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
  }

  if ($isLineBreakNode(node)) {
    return offset + Math.min(pointOffset, 1);
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    const clampedOffset = Math.max(0, Math.min(pointOffset, children.length));
    for (let i = 0; i < clampedOffset; i += 1) {
      const child = children[i];
      if (!child) continue;
      offset += getComposerNodeExpandedTextLength(child);
    }
    return offset;
  }

  return offset;
}

function findSelectionPointAtOffset(
  node: LexicalNode,
  remainingRef: { value: number },
): { key: string; offset: number; type: "text" | "element" } | null {
  if (node instanceof ComposerMentionNode) {
    return findSelectionPointForInlineToken(node, remainingRef);
  }
  if (node instanceof ComposerTerminalContextNode) {
    return findSelectionPointForInlineToken(node, remainingRef);
  }

  if ($isTextNode(node)) {
    const size = node.getTextContentSize();
    if (remainingRef.value <= size) {
      return {
        key: node.getKey(),
        offset: remainingRef.value,
        type: "text",
      };
    }
    remainingRef.value -= size;
    return null;
  }

  if ($isLineBreakNode(node)) {
    const parent = node.getParent();
    if (!parent) return null;
    const index = node.getIndexWithinParent();
    if (remainingRef.value === 0) {
      return {
        key: parent.getKey(),
        offset: index,
        type: "element",
      };
    }
    if (remainingRef.value === 1) {
      return {
        key: parent.getKey(),
        offset: index + 1,
        type: "element",
      };
    }
    remainingRef.value -= 1;
    return null;
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    for (const child of children) {
      const point = findSelectionPointAtOffset(child, remainingRef);
      if (point) {
        return point;
      }
    }
    if (remainingRef.value === 0) {
      return {
        key: node.getKey(),
        offset: children.length,
        type: "element",
      };
    }
  }

  return null;
}

function $getComposerRootLength(): number {
  const root = $getRoot();
  const children = root.getChildren();
  return children.reduce((sum, child) => sum + getComposerNodeTextLength(child), 0);
}

function $setSelectionAtComposerOffset(nextOffset: number): void {
  const root = $getRoot();
  const composerLength = $getComposerRootLength();
  const boundedOffset = Math.max(0, Math.min(nextOffset, composerLength));
  const remainingRef = { value: boundedOffset };
  const point = findSelectionPointAtOffset(root, remainingRef) ?? {
    key: root.getKey(),
    offset: root.getChildren().length,
    type: "element" as const,
  };
  const selection = $createRangeSelection();
  selection.anchor.set(point.key, point.offset, point.type);
  selection.focus.set(point.key, point.offset, point.type);
  $setSelection(selection);
}

function $setSelectionRangeAtComposerOffsets(startOffset: number, endOffset: number): void {
  const root = $getRoot();
  const composerLength = $getComposerRootLength();
  const rootEndPoint = {
    key: root.getKey(),
    offset: root.getChildren().length,
    type: "element" as const,
  };
  const anchorPoint =
    findSelectionPointAtOffset(root, {
      value: Math.max(0, Math.min(startOffset, composerLength)),
    }) ?? rootEndPoint;
  const focusPoint =
    findSelectionPointAtOffset(root, {
      value: Math.max(0, Math.min(endOffset, composerLength)),
    }) ?? rootEndPoint;
  const selection = $createRangeSelection();
  selection.anchor.set(anchorPoint.key, anchorPoint.offset, anchorPoint.type);
  selection.focus.set(focusPoint.key, focusPoint.offset, focusPoint.type);
  $setSelection(selection);
}

interface SurroundSelectionSnapshot {
  value: string;
  expandedStart: number;
  expandedEnd: number;
}

/** The current non-empty selection if it can be wrapped without splitting a mention or chip. */
function $readSurroundableSelection(): SurroundSelectionSnapshot | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || selection.isCollapsed()) {
    return null;
  }
  if (selection.getNodes().some((node) => isComposerInlineTokenNode(node))) {
    return null;
  }
  const anchorOffset = getExpandedAbsoluteOffsetForPoint(
    selection.anchor.getNode(),
    selection.anchor.offset,
  );
  const focusOffset = getExpandedAbsoluteOffsetForPoint(
    selection.focus.getNode(),
    selection.focus.offset,
  );
  const expandedStart = Math.min(anchorOffset, focusOffset);
  const expandedEnd = Math.max(anchorOffset, focusOffset);
  if (expandedStart === expandedEnd) {
    return null;
  }
  const value = $getRoot().getTextContent();
  if (selectionTouchesMentionBoundary(value, expandedStart, expandedEnd)) {
    return null;
  }
  return { value, expandedStart, expandedEnd };
}

function $readSelectionOffsetFromEditorState(fallback: number): number {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return fallback;
  }
  const anchorNode = selection.anchor.getNode();
  const offset = getAbsoluteOffsetForPoint(anchorNode, selection.anchor.offset);
  const composerLength = $getComposerRootLength();
  return Math.max(0, Math.min(offset, composerLength));
}

function $readExpandedSelectionOffsetFromEditorState(fallback: number): number {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return fallback;
  }
  const anchorNode = selection.anchor.getNode();
  const offset = getExpandedAbsoluteOffsetForPoint(anchorNode, selection.anchor.offset);
  const expandedLength = $getRoot().getTextContent().length;
  return Math.max(0, Math.min(offset, expandedLength));
}

function $appendTextWithLineBreaks(parent: ElementNode, text: string): void {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length > 0) {
      parent.append($createTextNode(line));
    }
    if (index < lines.length - 1) {
      parent.append($createLineBreakNode());
    }
  }
}

function $setComposerEditorPrompt(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft>,
): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);

  const segments = splitPromptIntoComposerSegments(prompt, terminalContexts);
  for (const segment of segments) {
    if (segment.type === "mention") {
      paragraph.append($createComposerMentionNode(segment.path));
      continue;
    }
    if (segment.type === "terminal-context") {
      if (segment.context) {
        paragraph.append($createComposerTerminalContextNode(segment.context));
      }
      continue;
    }
    $appendTextWithLineBreaks(paragraph, segment.text);
  }
}

function collectTerminalContextIds(node: LexicalNode): string[] {
  if (node instanceof ComposerTerminalContextNode) {
    return [node.__context.id];
  }
  if ($isElementNode(node)) {
    return node.getChildren().flatMap((child) => collectTerminalContextIds(child));
  }
  return [];
}

export interface ComposerPromptEditorHandle {
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  };
  /** Discrete, so a `readSnapshot` right after sees the new state. */
  deleteSelection: () => void;
  /** True when a collapsed caret is on the first ("start") or last ("end") visual line, soft wraps included. */
  isCaretOnVisualEdge: (edge: "start" | "end") => boolean;
}

/** Keys the composer hands to `onCommandKeyDown` before Lexical's defaults. */
export type ComposerCommandKey = "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape";

interface ComposerPromptEditorProps {
  value: string;
  cursor: number;
  /** When provided, a change marks `cursor` as a new programmatic move even if its value repeats. */
  cursorRequestId?: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  disabled: boolean;
  placeholder: string;
  ariaLabel?: string | undefined;
  /** Identifies an editor with suggestions, even while its list is closed. */
  suggestionListId?: string | undefined;
  /** References the highlighted option only while its list is rendered. */
  activeSuggestionId?: string | undefined;
  className?: string;
  onRemoveTerminalContext: (contextId: string) => void;
  onChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    terminalContextIds: string[],
  ) => void;
  // Method syntax: handlers typed for a subset of keys stay assignable.
  onCommandKeyDown?(key: ComposerCommandKey, event: KeyboardEvent): boolean;
  /** PageUp/PageDown that the composer does not need, for paging the chat timeline. */
  onPageScroll?: (direction: ComposerPageScrollDirection) => void;
  onPaste: ClipboardEventHandler<HTMLElement>;
}

interface ComposerPromptEditorInnerProps extends ComposerPromptEditorProps {
  editorRef: Ref<ComposerPromptEditorHandle>;
}

function ComposerCommandKeyPlugin(props: {
  onCommandKeyDown?: ((key: ComposerCommandKey, event: KeyboardEvent) => boolean) | undefined;
}) {
  const [editor] = useLexicalComposerContext();
  // Keep the latest handler in a ref so the Lexical commands register once per editor.
  const onCommandKeyDownRef = useRef(props.onCommandKeyDown);
  useLayoutEffect(() => {
    onCommandKeyDownRef.current = props.onCommandKeyDown;
  });

  useEffect(() => {
    const handleCommand = (key: ComposerCommandKey, event: KeyboardEvent | null): boolean => {
      const onCommandKeyDown = onCommandKeyDownRef.current;
      if (!onCommandKeyDown || !event) {
        return false;
      }
      if (key === "Enter" && isImeComposingKeyboardEvent(event)) {
        // Enter here only confirms the IME candidate; never treat it as send.
        event.stopPropagation();
        return true;
      }
      if (key === "Escape" && isImeComposingKeyboardEvent(event)) {
        // Escape cancels the IME candidate; leave it to the IME.
        return false;
      }
      const handled = onCommandKeyDown(key, event);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return handled;
    };

    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => handleCommand("ArrowDown", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => handleCommand("ArrowUp", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => handleCommand("Enter", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => handleCommand("Tab", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => handleCommand("Escape", event),
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterArrowDown();
      unregisterArrowUp();
      unregisterEnter();
      unregisterTab();
      unregisterEscape();
    };
  }, [editor]);

  return null;
}

function ComposerPageScrollKeyPlugin(props: {
  onPageScroll: (direction: ComposerPageScrollDirection) => void;
}) {
  const [editor] = useLexicalComposerContext();
  // Keep the latest handler in a ref so the Lexical command registers once per editor.
  const onPageScrollRef = useRef(props.onPageScroll);
  useLayoutEffect(() => {
    onPageScrollRef.current = props.onPageScroll;
  });

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        const rootElement = editor.getRootElement();
        const direction = resolveComposerPageScrollDirection(event, rootElement);
        if (!direction) return false;
        event.preventDefault();
        onPageScrollRef.current(direction);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}

/** Rect of the character at `offset` in a text node, for carets that report no rect. */
function probeTextCharRect(textNode: Text, offset: number): DOMRect | null {
  if (textNode.data.length === 0) return null;
  const probeStart = Math.max(0, Math.min(offset, textNode.data.length - 1));
  const probeRange = document.createRange();
  probeRange.setStart(textNode, probeStart);
  probeRange.setEnd(textNode, probeStart + 1);
  const probeRect = Array.from(probeRange.getClientRects()).find((rect) => rect.height > 0);
  if (probeRect) return probeRect;
  const boundingRect = probeRange.getBoundingClientRect();
  return boundingRect.height > 0 ? boundingRect : null;
}

/**
 * Client rect of the visual line the collapsed caret is on, as seen from `edge`.
 * A caret at a soft-wrap boundary belongs to two lines, so take the rect farthest
 * from the edge: an ambiguous caret never claims the key. Collapsed ranges report
 * zero-height rects at some positions, so probe the adjacent character instead.
 */
function caretLineRect(range: Range, edge: "start" | "end"): DOMRect | null {
  const collapsedRects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
  const collapsedRect = edge === "start" ? collapsedRects.at(-1) : collapsedRects[0];
  if (collapsedRect) return collapsedRect;

  const container = range.startContainer;
  if (container instanceof Text) {
    return probeTextCharRect(
      container,
      edge === "start" ? range.startOffset : range.startOffset - 1,
    );
  }
  if (!(container instanceof HTMLElement)) return null;
  // The caret sits between the paragraph's children (empty line or next to an inline chip).
  const before = container.childNodes[range.startOffset - 1];
  const neighbour = before ?? container.childNodes[range.startOffset];
  if (neighbour instanceof HTMLElement) {
    const neighbourRect = neighbour.getBoundingClientRect();
    if (neighbourRect.height > 0) return neighbourRect;
  } else if (neighbour instanceof Text) {
    const probeRect = probeTextCharRect(
      neighbour,
      neighbour === before ? neighbour.data.length - 1 : 0,
    );
    if (probeRect) return probeRect;
  }
  const containerRect = container.getBoundingClientRect();
  return containerRect.height > 0 ? containerRect : null;
}

function ComposerHomeEndKeyPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        const move = resolveComposerLineBoundaryMove(event, navigator.platform);
        if (!move) return false;
        const rootElement = editor.getRootElement();
        const selection = window.getSelection();
        const anchorNode = selection?.anchorNode;
        if (!rootElement || !selection || !anchorNode || !rootElement.contains(anchorNode)) {
          return false;
        }
        if (selection.rangeCount === 0 || typeof selection.modify !== "function") {
          return false;
        }
        event.preventDefault();
        event.stopPropagation();
        selection.modify(move.alter, move.direction, "lineboundary");
        editor.update(() => {
          $setSelection($createRangeSelectionFromDom(selection, editor));
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}

function ComposerInlineTokenArrowPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterLeft = editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          if (currentOffset <= 0) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "left")) {
            return;
          }
          nextOffset = currentOffset - 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          const composerLength = $getComposerRootLength();
          if (currentOffset >= composerLength) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "right")) {
            return;
          }
          nextOffset = currentOffset + 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      unregisterLeft();
      unregisterRight();
    };
  }, [editor]);

  return null;
}

function ComposerInlineTokenSelectionNormalizePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      let afterOffset: number | null = null;
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
        const anchorNode = selection.anchor.getNode();
        if (!isComposerInlineTokenNode(anchorNode)) return;
        if (selection.anchor.offset === 0) return;
        const beforeOffset = getAbsoluteOffsetForPoint(anchorNode, 0);
        afterOffset = beforeOffset + 1;
      });
      if (afterOffset !== null) {
        queueMicrotask(() => {
          editor.update(() => {
            $setSelectionAtComposerOffset(afterOffset!);
          });
        });
      }
    });
  }, [editor]);

  return null;
}

function ComposerInlineTokenBackspacePlugin() {
  const [editor] = useLexicalComposerContext();
  const { onRemoveTerminalContext } = useContext(ComposerTerminalContextActionsContext);

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const selectionOffset = $readSelectionOffsetFromEditorState(0);
        const removeInlineTokenNode = (candidate: unknown): boolean => {
          if (!isComposerInlineTokenNode(candidate)) {
            return false;
          }
          const tokenStart = getAbsoluteOffsetForPoint(candidate, 0);
          candidate.remove();
          if (candidate instanceof ComposerTerminalContextNode) {
            onRemoveTerminalContext(candidate.__context.id);
            $setSelectionAtComposerOffset(selectionOffset);
          } else {
            $setSelectionAtComposerOffset(tokenStart);
          }
          event?.preventDefault();
          return true;
        };
        if (removeInlineTokenNode(anchorNode)) {
          return true;
        }

        if ($isTextNode(anchorNode)) {
          if (selection.anchor.offset > 0) {
            return false;
          }
          if (removeInlineTokenNode(anchorNode.getPreviousSibling())) {
            return true;
          }
          const parent = anchorNode.getParent();
          if ($isElementNode(parent)) {
            const index = anchorNode.getIndexWithinParent();
            if (index > 0 && removeInlineTokenNode(parent.getChildAtIndex(index - 1))) {
              return true;
            }
          }
          return false;
        }

        if ($isElementNode(anchorNode)) {
          const childIndex = selection.anchor.offset - 1;
          if (childIndex >= 0 && removeInlineTokenNode(anchorNode.getChildAtIndex(childIndex))) {
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onRemoveTerminalContext]);

  return null;
}

// "*", "_" and "<" are left out: wrapping on them surprises more than it helps in prose.
const SURROUND_CLOSE_SYMBOLS = new Map<string, string>([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["'", "'"],
  ['"', '"'],
  ["“", "”"],
  ["`", "`"],
  ["«", "»"],
]);

/** Mirrors the range selection onto chips; the native highlight skips them. */
function ComposerChipSelectionPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let selectedKeys = new Set<NodeKey>();
    // Lexical keeps the selection on blur without an update, so focus is tracked separately.
    let hasFocus = editor.getRootElement() === document.activeElement;

    const applyKeys = (nextKeys: Set<NodeKey>) => {
      for (const key of selectedKeys) {
        if (!nextKeys.has(key)) {
          editor.getElementByKey(key)?.removeAttribute("data-composer-chip-selected");
        }
      }
      for (const key of nextKeys) {
        editor.getElementByKey(key)?.setAttribute("data-composer-chip-selected", "true");
      }
      selectedKeys = nextKeys;
    };

    const readSelectedKeys = () => {
      const nextKeys = new Set<NodeKey>();
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) return;
        for (const node of selection.getNodes()) {
          if (isComposerInlineTokenNode(node)) nextKeys.add(node.getKey());
        }
      });
      return nextKeys;
    };

    const unregisterUpdate = editor.registerUpdateListener(() => {
      applyKeys(hasFocus ? readSelectedKeys() : new Set());
    });
    const unregisterFocus = editor.registerCommand(
      FOCUS_COMMAND,
      () => {
        hasFocus = true;
        applyKeys(readSelectedKeys());
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        hasFocus = false;
        applyKeys(new Set());
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    return () => {
      unregisterUpdate();
      unregisterFocus();
      unregisterBlur();
    };
  }, [editor]);

  return null;
}

function ComposerSurroundSelectionPlugin(props: {
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  /** OnChangePlugin skips history-merge updates, so the merged dead-key wrap reports here. */
  onMergedChange: (editorState: EditorState) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const terminalContextsRef = useRef(props.terminalContexts);
  const onMergedChangeRef = useRef(props.onMergedChange);

  useEffect(() => {
    terminalContextsRef.current = props.terminalContexts;
    onMergedChangeRef.current = props.onMergedChange;
  }, [props.terminalContexts, props.onMergedChange]);

  useEffect(() => {
    // Selection captured on keydown, for dead keys and IME whose compositionstart replaces it.
    let pendingSelection: SurroundSelectionSnapshot | null = null;
    // A dead key resolves after its keyup, so only its snapshot outlives the key press.
    let pendingSelectionFromDeadKey = false;
    // Selection replaced by a dead-key/IME backtick, wrapped once the composition resolves.
    let pendingDeadKeySelection: SurroundSelectionSnapshot | null = null;

    const applySurround = (open: string): boolean => {
      const close = SURROUND_CLOSE_SYMBOLS.get(open);
      const deadKeySnapshot = pendingSelectionFromDeadKey ? pendingSelection : null;
      pendingSelection = null;
      pendingSelectionFromDeadKey = false;
      if (!close) return false;
      let handled = false;
      editor.update(() => {
        // Otherwise beforeinput runs before the DOM changes, so the live selection is still current.
        const snapshot = deadKeySnapshot ?? $readSurroundableSelection();
        if (!snapshot) return;
        const { value, expandedStart, expandedEnd } = snapshot;
        const selectedText = value.slice(expandedStart, expandedEnd);
        const nextValue = `${value.slice(0, expandedStart)}${open}${selectedText}${close}${value.slice(expandedEnd)}`;
        $setComposerEditorPrompt(nextValue, terminalContextsRef.current);
        const start = collapseExpandedComposerCursor(nextValue, expandedStart) + open.length;
        $setSelectionRangeAtComposerOffsets(start, start + selectedText.length);
        handled = true;
      });
      return handled;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (pendingDeadKeySelection) {
        if (event.key === "Dead" || event.key === " " || event.code === "Space") return;
        pendingDeadKeySelection = null;
      }
      pendingSelectionFromDeadKey = false;
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey) {
        pendingSelection = null;
        return;
      }
      pendingSelection = editor.getEditorState().read(() => $readSurroundableSelection());
      pendingSelectionFromDeadKey = event.key === "Dead";
    };
    // Shift, arrows and other keys without input would otherwise leave a stale snapshot behind.
    const onKeyUp = () => {
      if (!pendingSelectionFromDeadKey) pendingSelection = null;
    };

    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType === "insertCompositionText") {
        if (event.data === "`" && pendingSelection) {
          pendingDeadKeySelection = pendingSelection;
          pendingSelectionFromDeadKey = false;
        }
        return;
      }
      if (pendingDeadKeySelection) return;
      const data = event.inputType === "insertText" ? event.data : null;
      if (!data || data.length !== 1) {
        pendingSelection = null;
        pendingSelectionFromDeadKey = false;
        return;
      }
      if (!applySurround(data)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const tryWrapDeadKeyBacktick = (finalAttempt: boolean) => {
      queueMicrotask(() => {
        // Only start an update when the wrap applies: an empty history-merge commit splits undo steps.
        const snapshot = pendingDeadKeySelection;
        if (!snapshot) return;
        const { value, expandedStart, expandedEnd } = snapshot;
        const currentValue = editor.read(() => $getRoot().getTextContent());
        if (currentValue !== `${value.slice(0, expandedStart)}\`${value.slice(expandedEnd)}`) {
          if (finalAttempt) {
            pendingSelection = null;
            pendingSelectionFromDeadKey = false;
            pendingDeadKeySelection = null;
          }
          return;
        }
        pendingSelection = null;
        pendingDeadKeySelection = null;
        editor.update(
          () => {
            const selectedText = value.slice(expandedStart, expandedEnd);
            const start = collapseExpandedComposerCursor(currentValue, expandedStart);
            $setSelectionRangeAtComposerOffsets(start, start + 1);
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;
            selection.insertText(`\`${selectedText}\``);
            $setSelectionRangeAtComposerOffsets(start + 1, start + 1 + selectedText.length);
          },
          {
            tag: HISTORY_MERGE_TAG,
            onUpdate: () => onMergedChangeRef.current(editor.getEditorState()),
          },
        );
      });
    };

    const onInput = (event: Event) => {
      const { inputType } = event as InputEvent;
      if (inputType === "insertText" || inputType === "insertCompositionText") {
        tryWrapDeadKeyBacktick(false);
      }
    };
    const onCompositionEnd = () => tryWrapDeadKeyBacktick(true);

    let activeRoot: HTMLElement | null = null;
    const detach = (root: HTMLElement | null) => {
      root?.removeEventListener("keydown", onKeyDown);
      root?.removeEventListener("keyup", onKeyUp);
      root?.removeEventListener("beforeinput", onBeforeInput, true);
      root?.removeEventListener("input", onInput);
      root?.removeEventListener("compositionend", onCompositionEnd);
    };
    const unregisterRootListener = editor.registerRootListener((root, prevRoot) => {
      detach(prevRoot);
      root?.addEventListener("keydown", onKeyDown);
      root?.addEventListener("keyup", onKeyUp);
      root?.addEventListener("beforeinput", onBeforeInput, true);
      root?.addEventListener("input", onInput);
      root?.addEventListener("compositionend", onCompositionEnd);
      activeRoot = root;
    });
    return () => {
      detach(activeRoot);
      unregisterRootListener();
    };
  }, [editor]);

  return null;
}

function ComposerPromptEditorInner({
  value,
  cursor,
  cursorRequestId,
  terminalContexts,
  disabled,
  placeholder,
  ariaLabel,
  suggestionListId,
  activeSuggestionId,
  className,
  onRemoveTerminalContext,
  onChange,
  onCommandKeyDown,
  onPageScroll,
  onPaste,
  editorRef,
}: ComposerPromptEditorInnerProps) {
  const [editor] = useLexicalComposerContext();
  const onChangeRef = useRef(onChange);
  const initialCursor = clampCollapsedComposerCursor(value, cursor);
  const terminalContextsSignature = terminalContextSignature(terminalContexts);
  const terminalContextsSignatureRef = useRef(terminalContextsSignature);
  const snapshotRef = useRef({
    value,
    cursor: initialCursor,
    expandedCursor: expandCollapsedComposerCursor(value, initialCursor),
    terminalContextIds: terminalContexts.map((context) => context.id),
  });
  const isApplyingControlledUpdateRef = useRef(false);
  const terminalContextActions = useMemo(
    () => ({ onRemoveTerminalContext }),
    [onRemoveTerminalContext],
  );

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  const lastCursorPropRef = useRef({ cursor, cursorRequestId });

  useLayoutEffect(() => {
    const normalizedCursor = clampCollapsedComposerCursor(value, cursor);
    // The parent only re-renders the cursor prop for programmatic moves; while the
    // user types, the editor's own snapshot is the source of truth for the caret.
    const cursorPropChanged =
      lastCursorPropRef.current.cursor !== cursor ||
      lastCursorPropRef.current.cursorRequestId !== cursorRequestId;
    lastCursorPropRef.current = { cursor, cursorRequestId };
    const previousSnapshot = snapshotRef.current;
    const contextsChanged = terminalContextsSignatureRef.current !== terminalContextsSignature;
    if (
      previousSnapshot.value === value &&
      (!cursorPropChanged || previousSnapshot.cursor === normalizedCursor) &&
      !contextsChanged
    ) {
      return;
    }
    // A stale cursor prop must not move the live caret when only value/contexts are re-applied.
    const targetCursor = cursorPropChanged
      ? normalizedCursor
      : clampCollapsedComposerCursor(value, previousSnapshot.cursor);

    snapshotRef.current = {
      value,
      cursor: targetCursor,
      expandedCursor: expandCollapsedComposerCursor(value, targetCursor),
      terminalContextIds: terminalContexts.map((context) => context.id),
    };
    terminalContextsSignatureRef.current = terminalContextsSignature;

    const rootElement = editor.getRootElement();
    const isFocused = Boolean(rootElement && document.activeElement === rootElement);
    if (previousSnapshot.value === value && !contextsChanged && !isFocused) {
      return;
    }

    isApplyingControlledUpdateRef.current = true;
    editor.update(() => {
      const shouldRewriteEditorState = previousSnapshot.value !== value || contextsChanged;
      if (shouldRewriteEditorState) {
        $setComposerEditorPrompt(value, terminalContexts);
      }
      if (shouldRewriteEditorState || isFocused) {
        $setSelectionAtComposerOffset(targetCursor);
      }
    });
    queueMicrotask(() => {
      isApplyingControlledUpdateRef.current = false;
    });
  }, [cursor, cursorRequestId, editor, terminalContexts, terminalContextsSignature, value]);

  const focusAt = useCallback(
    (nextCursor: number) => {
      const rootElement = editor.getRootElement();
      if (!rootElement) return;
      const boundedCursor = clampCollapsedComposerCursor(snapshotRef.current.value, nextCursor);
      rootElement.focus();
      editor.update(() => {
        $setSelectionAtComposerOffset(boundedCursor);
      });
      snapshotRef.current = {
        value: snapshotRef.current.value,
        cursor: boundedCursor,
        expandedCursor: expandCollapsedComposerCursor(snapshotRef.current.value, boundedCursor),
        terminalContextIds: snapshotRef.current.terminalContextIds,
      };
      onChangeRef.current(
        snapshotRef.current.value,
        boundedCursor,
        snapshotRef.current.expandedCursor,
        false,
        snapshotRef.current.terminalContextIds,
      );
    },
    [editor],
  );

  const readSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    let snapshot = snapshotRef.current;
    editor.getEditorState().read(() => {
      const nextValue = $getRoot().getTextContent();
      const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCollapsedComposerCursor(
        nextValue,
        $readSelectionOffsetFromEditorState(fallbackCursor),
      );
      const fallbackExpandedCursor = clampExpandedCursor(
        nextValue,
        snapshotRef.current.expandedCursor,
      );
      const nextExpandedCursor = clampExpandedCursor(
        nextValue,
        $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
      );
      const terminalContextIds = collectTerminalContextIds($getRoot());
      snapshot = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
        terminalContextIds,
      };
    });
    snapshotRef.current = snapshot;
    return snapshot;
  }, [editor]);

  useImperativeHandle(
    editorRef,
    () => ({
      focus: () => {
        focusAt(snapshotRef.current.cursor);
      },
      focusAt,
      focusAtEnd: () => {
        focusAt(
          collapseExpandedComposerCursor(
            snapshotRef.current.value,
            snapshotRef.current.value.length,
          ),
        );
      },
      readSnapshot,
      deleteSelection: () => {
        editor.update(
          () => {
            const selection = $getSelection();
            if ($isRangeSelection(selection) && !selection.isCollapsed()) selection.removeText();
          },
          { discrete: true },
        );
      },
      isCaretOnVisualEdge: (edge) => {
        const snapshot = readSnapshot();
        if (snapshot.value.length === 0) return true;
        const beforeCaret = snapshot.value.slice(0, snapshot.expandedCursor);
        const afterCaret = snapshot.value.slice(snapshot.expandedCursor);
        if (edge === "start" ? beforeCaret.includes("\n") : afterCaret.includes("\n")) {
          return false;
        }
        const rootElement = editor.getRootElement();
        const selection = window.getSelection();
        if (
          !rootElement ||
          !selection ||
          !selection.isCollapsed ||
          selection.rangeCount === 0 ||
          !selection.anchorNode ||
          !rootElement.contains(selection.anchorNode)
        ) {
          return false;
        }
        const caretRect = caretLineRect(selection.getRangeAt(0), edge);
        if (!caretRect) return false;
        const edgeElement =
          edge === "start" ? rootElement.firstElementChild : rootElement.lastElementChild;
        const edgeRect = (edgeElement ?? rootElement).getBoundingClientRect();
        const threshold = caretRect.height / 2;
        return edge === "start"
          ? caretRect.top - edgeRect.top < threshold
          : edgeRect.bottom - caretRect.bottom < threshold;
      },
    }),
    [editor, focusAt, readSnapshot],
  );

  const handleEditorChange = useCallback((editorState: EditorState) => {
    editorState.read(() => {
      const nextValue = $getRoot().getTextContent();
      const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCollapsedComposerCursor(
        nextValue,
        $readSelectionOffsetFromEditorState(fallbackCursor),
      );
      const fallbackExpandedCursor = clampExpandedCursor(
        nextValue,
        snapshotRef.current.expandedCursor,
      );
      const nextExpandedCursor = clampExpandedCursor(
        nextValue,
        $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
      );
      const terminalContextIds = collectTerminalContextIds($getRoot());
      const previousSnapshot = snapshotRef.current;
      if (
        previousSnapshot.value === nextValue &&
        previousSnapshot.cursor === nextCursor &&
        previousSnapshot.expandedCursor === nextExpandedCursor &&
        previousSnapshot.terminalContextIds.length === terminalContextIds.length &&
        previousSnapshot.terminalContextIds.every((id, index) => id === terminalContextIds[index])
      ) {
        return;
      }
      if (isApplyingControlledUpdateRef.current) {
        return;
      }
      snapshotRef.current = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
        terminalContextIds,
      };
      const cursorAdjacentToMention =
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "left") ||
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "right");
      onChangeRef.current(
        nextValue,
        nextCursor,
        nextExpandedCursor,
        cursorAdjacentToMention,
        terminalContextIds,
      );
    });
  }, []);

  return (
    <ComposerTerminalContextActionsContext.Provider value={terminalContextActions}>
      <div className="relative">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className={cn(
                "block max-h-[12.5rem] [@media(max-height:34rem)]:max-h-[25dvh] [@media(max-height:34rem)]:min-h-12 min-h-17.5 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-[0.875rem] leading-relaxed text-foreground focus:outline-none",
                className,
              )}
              data-testid="composer-editor"
              ariaMultiline
              {...(ariaLabel ? { ariaLabel } : {})}
              {...(suggestionListId && !disabled
                ? {
                    ariaAutoComplete: "list" as const,
                    "aria-haspopup": "listbox" as const,
                    ...(activeSuggestionId
                      ? { ariaControls: suggestionListId, ariaActiveDescendant: activeSuggestionId }
                      : {}),
                  }
                : {})}
              aria-placeholder={placeholder}
              placeholder={<span />}
              onPaste={onPaste}
            />
          }
          placeholder={
            terminalContexts.length > 0 ? null : (
              <div className="pointer-events-none absolute inset-0 text-[0.875rem] leading-relaxed text-muted-foreground/35">
                {placeholder}
              </div>
            )
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <OnChangePlugin onChange={handleEditorChange} />
        <ComposerCommandKeyPlugin {...(onCommandKeyDown ? { onCommandKeyDown } : {})} />
        <ComposerSurroundSelectionPlugin
          terminalContexts={terminalContexts}
          onMergedChange={handleEditorChange}
        />
        {onPageScroll ? <ComposerPageScrollKeyPlugin onPageScroll={onPageScroll} /> : null}
        <ComposerHomeEndKeyPlugin />
        <ComposerInlineTokenArrowPlugin />
        <ComposerInlineTokenSelectionNormalizePlugin />
        <ComposerInlineTokenBackspacePlugin />
        <ComposerChipSelectionPlugin />
        <HistoryPlugin />
      </div>
    </ComposerTerminalContextActionsContext.Provider>
  );
}

export const ComposerPromptEditor = forwardRef<
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps
>(function ComposerPromptEditor(
  {
    value,
    cursor,
    cursorRequestId,
    terminalContexts,
    disabled,
    placeholder,
    ariaLabel,
    suggestionListId,
    activeSuggestionId,
    className,
    onRemoveTerminalContext,
    onChange,
    onCommandKeyDown,
    onPageScroll,
    onPaste,
  },
  ref,
) {
  const initialValueRef = useRef(value);
  const initialTerminalContextsRef = useRef(terminalContexts);
  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: "piedpiper-composer-editor",
      editable: true,
      nodes: [ComposerMentionNode, ComposerTerminalContextNode],
      editorState: () => {
        $setComposerEditorPrompt(initialValueRef.current, initialTerminalContextsRef.current);
      },
      onError: (error) => {
        throw error;
      },
    }),
    [],
  );

  return (
    <LexicalComposer key={COMPOSER_EDITOR_HMR_KEY} initialConfig={initialConfig}>
      <ComposerPromptEditorInner
        value={value}
        cursor={cursor}
        {...(cursorRequestId !== undefined ? { cursorRequestId } : {})}
        terminalContexts={terminalContexts}
        disabled={disabled}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        suggestionListId={suggestionListId}
        activeSuggestionId={activeSuggestionId}
        onRemoveTerminalContext={onRemoveTerminalContext}
        onChange={onChange}
        onPaste={onPaste}
        editorRef={ref}
        {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
        {...(onPageScroll ? { onPageScroll } : {})}
        {...(className ? { className } : {})}
      />
    </LexicalComposer>
  );
});

export { isImeComposingKeyboardEvent };
