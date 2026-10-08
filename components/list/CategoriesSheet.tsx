"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { DragDropProvider } from "@dnd-kit/react";
import type { DragDropEvents } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import type { ListCategory } from "@/src/types";
import { categoryLabel, MAX_CATEGORIES_PER_LIST } from "@/src/types/categories";
import { askConfirm } from "@/src/types/telegram";
import { restoreCategory, restoreCategoryName, restorePositions, sortCategories } from "@/src/utils/category-state";
import {
  createCategory, deleteCategory, renameCategory, reorderCategories, runCategoryAction,
} from "@/src/utils/category-api";

interface CategoriesSheetProps {
  listId: string;
  jwtRef: React.RefObject<string | null>;
  categories: ListCategory[];
  /** Items still to buy per category id; a category missing here has none. */
  counts: Map<string, number>;
  setCategories: React.Dispatch<React.SetStateAction<ListCategory[]>>;
  onClose: () => void;
}

function CategoryRow({
  category, index, label, count, onRename, onDelete,
}: {
  category: ListCategory;
  index: number;
  label: string;
  count: number;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const t = useTranslations();
  const { ref, handleRef, isDragSource } = useSortable({ id: category.id, index });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);

  return (
    <div ref={ref} className={`flex items-center gap-2 py-2.5 border-b border-separator ${isDragSource ? "opacity-50" : ""}`}>
      <button ref={handleRef} className="p-1 text-tg-hint touch-none" aria-label={t("categories.reorder")}>
        <GripVertical className="w-4 h-4" />
      </button>
      {editing ? (
        <input
          autoFocus
          value={draft}
          maxLength={40}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { setEditing(false); if (draft.trim() && draft.trim() !== label) onRename(draft.trim()); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="flex-1 bg-tg-secondary-bg rounded-lg px-2 py-1 text-tg-text"
        />
      ) : (
        <button className="flex-1 text-start text-tg-text" onClick={() => { setDraft(label); setEditing(true); }}>
          {label}
        </button>
      )}
      <span className="shrink-0 min-w-5 text-end text-[13px] tabular-nums text-tg-hint">
        <span aria-hidden="true">{count}</span>
        <span className="sr-only">{t("categories.itemCount", { count })}</span>
      </span>
      <button onClick={onDelete} className="p-1 text-tg-hint" aria-label={t("common.delete")}>
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

export default function CategoriesSheet({ listId, jwtRef, categories, counts, setCategories, onClose }: CategoriesSheetProps) {
  const t = useTranslations();
  const locale = useLocale();
  const [newName, setNewName] = useState("");
  // Shown inside the sheet: the page's toasts sit under this overlay.
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const ordered = sortCategories(categories);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  const run = (action: (jwt: string) => Promise<void>, undo?: () => void) => {
    setError(null);
    void runCategoryAction(jwtRef.current, action, () => {
      undo?.();
      setError(t("categories.error"));
    });
  };

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    run(async (jwt) => {
      const created = await createCategory(listId, jwt, name, locale);
      setCategories((prev) => sortCategories([...prev.filter((c) => c.id !== created.id), created]));
    });
  };

  const rename = (original: ListCategory, name: string) => {
    setCategories((prev) => prev.map((c) => (c.id === original.id ? { ...c, [`name_${locale}`]: name } : c)));
    run(async (jwt) => {
      const updated = await renameCategory(listId, jwt, original.id, name, locale);
      setCategories((prev) => prev.map((c) => (c.id === original.id ? updated : c)));
    }, () => setCategories((prev) => restoreCategoryName(prev, original, locale)));
  };

  const remove = (original: ListCategory) => {
    setCategories((prev) => prev.filter((c) => c.id !== original.id));
    run((jwt) => deleteCategory(listId, jwt, original.id), () => setCategories((prev) => restoreCategory(prev, original)));
  };

  const onDragEnd: DragDropEvents["dragend"] = (event) => {
    if (event.canceled) return;
    const { source } = event.operation;
    const to = (source as { sortable?: { index: number } } | null)?.sortable?.index;
    const from = ordered.findIndex((c) => c.id === source?.id);
    if (to == null || from === -1 || from === to) return;
    const next = [...ordered];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setCategories(next.map((c, position) => ({ ...c, position })));
    run((jwt) => reorderCategories(listId, jwt, next.map((c) => c.id)), () => setCategories((prev) => restorePositions(prev, ordered)));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm backdrop-enter" onClick={onClose}>
      <div className="bg-tg-bg w-full max-w-lg rounded-t-3xl p-6 pt-3 sheet-enter max-h-[80dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-tg-hint/30 mx-auto mb-4" />
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <h2 className="text-lg font-semibold tracking-tight text-tg-text">{t("categories.title")}</h2>
          {ordered.length > 0 && (
            <span className="text-[13px] tabular-nums text-tg-hint">
              {t("categories.total", { count: ordered.length, max: MAX_CATEGORIES_PER_LIST })}
            </span>
          )}
        </div>
        {ordered.length === 0 && <p className="text-sm text-tg-hint mb-3">{t("categories.empty")}</p>}
        <DragDropProvider onDragEnd={onDragEnd}>
          {ordered.map((c, index) => (
            <CategoryRow
              key={c.id}
              category={c}
              index={index}
              label={categoryLabel(c, locale)}
              count={counts.get(c.id) ?? 0}
              onRename={(name) => rename(c, name)}
              onDelete={() => askConfirm(t("categories.confirmDelete", { name: categoryLabel(c, locale) }), () => remove(c))}
            />
          ))}
        </DragDropProvider>
        {error && (
          <p ref={errorRef} role="alert" className="mt-3 text-sm text-tg-destructive">{error}</p>
        )}
        <div className="flex items-center gap-2 mt-4">
          <input
            value={newName}
            maxLength={40}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder={t("categories.placeholder")}
            className="flex-1 bg-tg-secondary-bg rounded-xl px-3 py-2.5 text-tg-text"
          />
          <button onClick={add} className="p-2.5 rounded-xl bg-tg-button text-tg-button-text" aria-label={t("categories.add")}>
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <button onClick={onClose} className="w-full mt-4 py-3.5 rounded-2xl bg-tg-secondary-bg text-tg-text font-medium active:scale-[0.98]">
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}
