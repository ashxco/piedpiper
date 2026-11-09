import { EditorId, type ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import { memo, useEffect } from "react";
import {
  isOpenFavoriteEditorShortcut,
  resolveContextualShortcutOutcome,
  shortcutLabelForCommand,
} from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import { isInsideConfirmationDialog } from "../../lib/confirmationDialogGuard";
import { ChevronDownIcon, FolderClosedIcon } from "lucide-react";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import {
  AntigravityIcon,
  CursorIcon,
  Icon,
  TraeIcon,
  IntelliJIdeaIcon,
  VisualStudioCode,
  Zed,
} from "../Icons";
import { FileExplorerIcon, FinderIcon } from "./OpenInPickerIcons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  KiroIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  VSCodium,
  VisualStudioCodeInsiders,
  WebStormIcon,
} from "./OpenInPickerEditorIcons";
import { announce } from "../../lib/announce";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";

type OpenInOption = {
  label: string;
  Icon: Icon;
  value: EditorId;
  kind: "brand" | "generic";
};

export const resolveOpenInOptions = (
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
) => {
  const baseOptions: ReadonlyArray<OpenInOption> = [
    {
      label: "Cursor",
      Icon: CursorIcon,
      value: "cursor",
      kind: "brand",
    },
    {
      label: "Trae",
      Icon: TraeIcon,
      value: "trae",
      kind: "brand",
    },
    {
      label: "VS Code",
      Icon: VisualStudioCode,
      value: "vscode",
      kind: "brand",
    },
    {
      label: "VS Code Insiders",
      Icon: VisualStudioCodeInsiders,
      value: "vscode-insiders",
      kind: "brand",
    },
    {
      label: "VSCodium",
      Icon: VSCodium,
      value: "vscodium",
      kind: "brand",
    },
    {
      label: "Zed",
      Icon: Zed,
      value: "zed",
      kind: "brand",
    },
    {
      label: "Antigravity",
      Icon: AntigravityIcon,
      value: "antigravity",
      kind: "brand",
    },
    {
      label: "IntelliJ IDEA",
      Icon: IntelliJIdeaIcon,
      value: "idea",
      kind: "brand",
    },
    {
      label: "Kiro",
      Icon: KiroIcon,
      value: "kiro",
      kind: "brand",
    },
    {
      label: "Aqua",
      Icon: AquaIcon,
      value: "aqua",
      kind: "brand",
    },
    {
      label: "CLion",
      Icon: CLionIcon,
      value: "clion",
      kind: "brand",
    },
    {
      label: "DataGrip",
      Icon: DataGripIcon,
      value: "datagrip",
      kind: "brand",
    },
    {
      label: "DataSpell",
      Icon: DataSpellIcon,
      value: "dataspell",
      kind: "brand",
    },
    {
      label: "GoLand",
      Icon: GoLandIcon,
      value: "goland",
      kind: "brand",
    },
    {
      label: "PhpStorm",
      Icon: PhpStormIcon,
      value: "phpstorm",
      kind: "brand",
    },
    {
      label: "PyCharm",
      Icon: PyCharmIcon,
      value: "pycharm",
      kind: "brand",
    },
    {
      label: "Rider",
      Icon: RiderIcon,
      value: "rider",
      kind: "brand",
    },
    {
      label: "RubyMine",
      Icon: RubyMineIcon,
      value: "rubymine",
      kind: "brand",
    },
    {
      label: "RustRover",
      Icon: RustRoverIcon,
      value: "rustrover",
      kind: "brand",
    },
    {
      label: "WebStorm",
      Icon: WebStormIcon,
      value: "webstorm",
      kind: "brand",
    },
    {
      label: isMacPlatform(platform)
        ? "Finder"
        : isWindowsPlatform(platform)
          ? "File Explorer"
          : "Files",
      Icon: isMacPlatform(platform)
        ? FinderIcon
        : isWindowsPlatform(platform)
          ? FileExplorerIcon
          : FolderClosedIcon,
      value: "file-manager",
      kind: isMacPlatform(platform) || isWindowsPlatform(platform) ? "brand" : "generic",
    },
  ];
  return baseOptions.filter((option) => availableEditors.includes(option.value));
};

/** Logos keep full strength; opacity-100 opts out of the dimming Button and MenuItem give icons. */
export function getOpenInIconClass(kind: OpenInOption["kind"]): string {
  return kind === "brand" ? "text-foreground opacity-100" : "text-muted-foreground";
}

/** Resolves false after showing a toast naming the editor, so callers need no error handling. */
export function openInEditorWithErrorToast(
  openInEditor: (cwd: string, editor: EditorId) => Promise<void>,
  cwd: string,
  editor: EditorId,
  editorLabel: string,
): Promise<boolean> {
  return openInEditor(cwd, editor).then(
    () => true,
    (error: unknown) => {
      toastManager.add({
        type: "error",
        title: `Could not open in ${editorLabel}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return false;
    },
  );
}

/** Shortcut-only path: mouse opens are visible, so only this one is announced to screen readers. */
export function openFavoriteEditorFromShortcut(
  openInEditor: (cwd: string, editor: EditorId) => Promise<void>,
  cwd: string,
  editor: EditorId,
  editorLabel: string,
): Promise<void> {
  return openInEditorWithErrorToast(openInEditor, cwd, editor, editorLabel).then((opened) => {
    if (opened) announce(`Opened in ${editorLabel}`, "open-in-editor");
  });
}

/** `open` is null while nothing can be opened, which leaves the key to the browser. */
export function runOpenFavoriteEditorShortcut(
  event: Pick<globalThis.KeyboardEvent, "repeat" | "preventDefault">,
  open: (() => void) | null,
): void {
  const outcome = resolveContextualShortcutOutcome(event, open !== null);
  if (outcome === "pass") return;
  event.preventDefault();
  if (outcome === "handle") open?.();
}

export const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors,
  openInCwd,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = resolveOpenInOptions(navigator.platform, availableEditors);
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;
  const preferredEditorLabel = primaryOption?.label ?? "editor";

  const openPreferredEditor = () => {
    const api = readNativeApi();
    if (!api || !openInCwd || !preferredEditor) return;
    void openInEditorWithErrorToast(
      (cwd, target) => api.shell.openInEditor(cwd, target),
      openInCwd,
      preferredEditor,
      preferredEditorLabel,
    );
    setPreferredEditor(preferredEditor);
  };

  const openFavoriteEditorShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "editor.openFavorite",
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (isInsideConfirmationDialog(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const api = readNativeApi();
      runOpenFavoriteEditorShortcut(
        e,
        api && openInCwd && preferredEditor
          ? () =>
              void openFavoriteEditorFromShortcut(
                (cwd, editor) => api.shell.openInEditor(cwd, editor),
                openInCwd,
                preferredEditor,
                preferredEditorLabel,
              )
          : null,
      );
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [preferredEditor, preferredEditorLabel, keybindings, openInCwd]);

  return (
    <Group aria-label="Open in editor">
      <Button
        size="xs"
        variant="outline"
        aria-label={`Open in ${preferredEditorLabel}`}
        disabled={!preferredEditor || !openInCwd}
        onClick={openPreferredEditor}
      >
        {primaryOption?.Icon && (
          <primaryOption.Icon
            aria-hidden="true"
            className={cn("size-3.5", getOpenInIconClass(primaryOption.kind))}
          />
        )}
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          Open
        </span>
      </Button>
      <GroupSeparator className="hidden @3xl/header-actions:block" />
      <Menu>
        <MenuTrigger
          render={<Button aria-label="Choose editor" size="icon-xs" variant="outline" />}
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
          {options.map(({ label, Icon, value, kind }) => (
            <MenuItem
              key={value}
              onClick={() => {
                setPreferredEditor(value);
                // Nothing launches and focus returns to the trigger, so nothing else is spoken.
                announce(`${label} set as default editor`, "open-in-editor");
              }}
            >
              <Icon aria-hidden="true" className={getOpenInIconClass(kind)} />
              {label}
              {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
