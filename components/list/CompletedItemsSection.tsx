"use client";

import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import ItemRow from "@/components/ItemRow";
import type { ItemData, CompletedGroup } from "@/src/types";

interface CompletedItemsSectionProps {
  completedItems: ItemData[];
  completedGroups: CompletedGroup[];
  showCompleted: boolean;
  setShowCompleted: React.Dispatch<React.SetStateAction<boolean>>;
  duplicateTexts: Set<string>;
  isShared: boolean;
  userId: string | null;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
  onClearCompleted: () => void;
}

export default function CompletedItemsSection({
  completedItems,
  completedGroups,
  showCompleted,
  setShowCompleted,
  duplicateTexts,
  isShared,
  userId,
  onToggle,
  onDelete,
  onEdit,
  onClearCompleted,
}: CompletedItemsSectionProps) {
  const t = useTranslations();

  if (completedItems.length === 0) return null;

  return (
    <>
      <button
        ref={(el) => {
          if (el) {
            const container = el.parentElement?.parentElement;
            if (container) container.style.setProperty('--done-header-h', `${el.offsetHeight}px`);
          }
        }}
        onClick={() => setShowCompleted((p) => { localStorage.setItem("panel_completed", String(!p)); return !p; })}
        className="sticky top-0 z-20 flex items-center gap-2 w-full px-4 py-3 text-sm text-tg-hint bg-tg-secondary-bg border-t border-tg-hint/20"
      >
        {showCompleted ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4 rtl:scale-x-[-1]" />
        )}
        {t('items.completedSection', { count: completedItems.length })}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClearCompleted();
          }}
          className="ms-auto text-tg-destructive text-xs flex items-center gap-1"
        >
          <Trash2 className="w-3 h-3" />
          {t('items.clearCompleted')}
        </button>
      </button>
      {showCompleted &&
        completedGroups.map((group) => (
          <div key={group.label}>
            <div className="sticky z-10 px-4 pt-3 pb-1 text-xs text-tg-hint font-medium bg-tg-secondary-bg" style={{ top: 'var(--done-header-h, 44px)' }}>
              {group.label}
            </div>
            {group.items.map((item) => (
              <ItemRow
                key={item.id}
                id={item.id}
                text={item.text}
                completed={true}
                isDuplicate={duplicateTexts.has(item.text.toLowerCase())}
                creatorName={isShared ? item.creator_name : null}
                isOwnItem={item.created_by === userId}
                editorName={isShared ? item.editor_name : null}
                isOwnEdit={item.edited_by === userId || item.edited_by === item.created_by}
                onToggle={onToggle}
                onDelete={onDelete}
                onEdit={onEdit}
              />
            ))}
          </div>
        ))}
    </>
  );
}
