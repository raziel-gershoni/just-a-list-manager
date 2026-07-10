import {
  ShoppingCart,
  Bell,
  ListChecks,
  Plane,
  Briefcase,
  Heart,
  BookOpen,
  Dumbbell,
  Gift,
  Home,
  Utensils,
  PartyPopper,
  Pill,
  DollarSign,
  Wrench,
  Sparkles,
  // Food & drink
  Coffee,
  Wine,
  Cake,
  Apple,
  // Travel & outdoors
  Car,
  MapPin,
  Mountain,
  Tent,
  Fuel,
  // Pets & family
  Dog,
  Cat,
  Baby,
  // Health
  HeartPulse,
  Stethoscope,
  // Work & study
  GraduationCap,
  Laptop,
  Calendar,
  // Home & garden
  Shirt,
  Leaf,
  Flower2,
  Hammer,
  // Deliveries & goals
  Package,
  Truck,
  Rocket,
  // Hobbies
  Music,
  Camera,
  Gamepad2,
  Palette,
  Star,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";

export const LIST_ICONS = {
  ShoppingCart,
  Bell,
  ListChecks,
  Plane,
  Briefcase,
  Heart,
  BookOpen,
  Dumbbell,
  Gift,
  Home,
  Utensils,
  PartyPopper,
  Pill,
  DollarSign,
  Wrench,
  Sparkles,
  // Food & drink
  Coffee,
  Wine,
  Cake,
  Apple,
  // Travel & outdoors
  Car,
  MapPin,
  Mountain,
  Tent,
  Fuel,
  // Pets & family
  Dog,
  Cat,
  Baby,
  // Health
  HeartPulse,
  Stethoscope,
  // Work & study
  GraduationCap,
  Laptop,
  Calendar,
  // Home & garden
  Shirt,
  Leaf,
  Flower2,
  Hammer,
  // Deliveries & goals
  Package,
  Truck,
  Rocket,
  // Hobbies
  Music,
  Camera,
  Gamepad2,
  Palette,
  Star,
  Lightbulb,
} as const satisfies Record<string, LucideIcon>;

export type ListIconName = keyof typeof LIST_ICONS;
export const LIST_ICON_NAMES = Object.keys(LIST_ICONS) as ListIconName[];

export const LIST_COLORS = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "emerald",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "fuchsia",
  "rose",
  "slate",
  "stone",
] as const;
export type ListColor = (typeof LIST_COLORS)[number];

export type ListType = "regular" | "reminders" | "grocery";

export const defaultIconFor = (t: ListType): ListIconName =>
  t === "grocery" ? "ShoppingCart" : t === "reminders" ? "Bell" : "ListChecks";

export const defaultColorFor = (t: ListType): ListColor =>
  t === "grocery" ? "emerald" : t === "reminders" ? "blue" : "slate";

export const resolveIcon = (
  icon: ListIconName | string | null | undefined,
  t: ListType
): LucideIcon => {
  if (icon && icon in LIST_ICONS) return LIST_ICONS[icon as ListIconName];
  return LIST_ICONS[defaultIconFor(t)];
};

export const resolveColor = (
  color: ListColor | string | null | undefined,
  t: ListType
): ListColor => {
  if (color && (LIST_COLORS as readonly string[]).includes(color)) {
    return color as ListColor;
  }
  return defaultColorFor(t);
};

export const listAccentVar = (
  color: ListColor | string | null | undefined,
  t: ListType
): string => `var(--list-${resolveColor(color, t)})`;
