import { TOOL_LIFECYCLE_ITEM_TYPES, type ToolLifecycleItemType } from "@piedpiper/contracts";

export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return TOOL_LIFECYCLE_ITEM_TYPES.includes(value as ToolLifecycleItemType);
}
