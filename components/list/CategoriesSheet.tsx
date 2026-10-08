"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { DragDropProvider } from "@dnd-kit/react";
import type { DragDropEvents } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import type { ListCategory } from "@/src/types";
import { categoryLabel } from "@/src/types/categories";
import { sortCategories } from "@/src/utils/category-state";
import { createCategory, deleteCategory, renameCategory, reorderCategories } from "@/src/utils/category-api";

interface CategoriesSheetProps {
  listId: string;
  jwtRef: React.RefObject<string | null>;
  categories: ListCategory[];
  setCategories: React.Dispatch<React.SetStateAction<ListCategory[]>>;
  onClose: () => void;
  onError: (message: string) => void;
}

function CategoryRow({
  category, index, label, onRename, onDelete,
}: {
  category: ListCategory;
  index: number;
  label: string;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const t = useTranslations();
  const { ref, handleRef, isDragSource } = useSortable({ id: category.id, index });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const [confirming, setConfirming] = useState(false);

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
      <button
        onClick={() => (confirming ? onDelete() : setConfirming(true))}
        onBlur={() => setConfirming(false)}
        className={`text-[12px] flex items-center gap-1 ${confirming ? "text-tg-destructive" : "text-tg-hint"}`}
      >
        <Trash2 className="w-3.5 h-3.5" />
        {confirming ? t("categories.confirmDelete") : null}
      </button>
    </div>
  );
}

export default function CategoriesSheet({ listId, jwtRef, categories, setCategories, onClose, onError }: CategoriesSheetProps) {
  const t = useTranslations();
  const locale = useLocale();
  const [newName, setNewName] = useState("");
  const ordered = sortCategories(categories);

  const run = async (action: (jwt: string) => Promise<void>, rollback: ListCategory[]) => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    try {
      await action(jwt);
    } catch {
      setCategories(rollback);
      onError(t("categories.error"));
    }
  };

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    const before = categories;
    void run(async (jwt) => {
      const created = await createCategory(listId, jwt, name, locale);
      setCategories((prev) => sortCategories([...prev.filter((c) => c.id !== created.id), created]));
    }, before);
  };

  const rename = (id: string, name: string) => {
    const before = categories;
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, [`name_${locale}`]: name } : c)));
    void run(async (jwt) => {
      const updated = await renameCategory(listId, jwt, id, name, locale);
      setCategories((prev) => prev.map((c) => (c.id === id ? updated : c)));
    }, before);
  };

  const remove = (id: string) => {
    const before = categories;
    setCategories((prev) => prev.filter((c) => c.id !== id));
    void run((jwt) => deleteCategory(listId, jwt, id), before);
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
    const before = categories;
    setCategories(next.map((c, position) => ({ ...c, position })));
    void run((jwt) => reorderCategories(listId, jwt, next.map((c) => c.id)), before);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm backdrop-enter" onClick={onClose}>
      <div className="bg-tg-bg w-full max-w-lg rounded-t-3xl p-6 pt-3 sheet-enter max-h-[80dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-tg-hint/30 mx-auto mb-4" />
        <h2 className="text-lg font-semibold tracking-tight text-tg-text mb-2">{t("categories.title")}</h2>
        {ordered.length === 0 && <p className="text-sm text-tg-hint mb-3">{t("categories.empty")}</p>}
        <DragDropProvider onDragEnd={onDragEnd}>
          {ordered.map((c, index) => (
            <CategoryRow
              key={c.id}
              category={c}
              index={index}
              label={categoryLabel(c, locale)}
              onRename={(name) => rename(c.id, name)}
              onDelete={() => remove(c.id)}
            />
          ))}
        </DragDropProvider>
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
