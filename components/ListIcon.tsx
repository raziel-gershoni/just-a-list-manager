"use client";

import { createElement, type CSSProperties } from "react";
import { resolveIcon, type ListIconName, type ListType } from "@/src/lib/list-icons";

interface ListIconProps {
  iconName: ListIconName | null;
  type: ListType;
  className?: string;
  strokeWidth?: number;
  style?: CSSProperties;
}

export default function ListIcon({ iconName, type, className, strokeWidth, style }: ListIconProps) {
  const Icon = resolveIcon(iconName, type);
  return createElement(Icon, { className, strokeWidth, style });
}
