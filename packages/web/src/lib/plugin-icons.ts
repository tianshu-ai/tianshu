// Whitelist of lucide-react icon names plugins may reference in
// `manifest.contributes.topBarButtons[*].icon`.
//
// Named imports keep tree-shaking working — a `* as Icons` import
// pulled the whole library and roughly doubled the production bundle.
// If a plugin needs an icon that isn't here, add it in the same PR
// that introduces the plugin so the bundle impact is reviewed.

import {
  Bot,
  Calendar,
  CalendarClock,
  FileText,
  FolderOpen,
  Globe,
  Kanban,
  MessageSquare,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ComponentType } from "react";

export const ICONS_BY_NAME: Record<string, ComponentType<{ size?: number }>> = {
  Bot,
  Calendar,
  CalendarClock,
  FileText,
  FolderOpen,
  Globe,
  Kanban,
  MessageSquare,
  Search,
  Terminal,
  Wrench,
};
