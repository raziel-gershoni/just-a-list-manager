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
        className="sticky top-0 z-20 flex items-center gap-2.5 w-full px-5 py-3.5 text-[13px] font-medium tracking-wide text-tg-hint bg-tg-secondary-bg/80 backdrop-blur-md border-t border-separator"
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
          className="ms-auto text-tg-destructive/80 text-[12px] font-medium tracking-wide flex items-center gap-1"
        >
          <Trash2 className="w-3 h-3" />
          {t('items.clearCompleted')}
        </button>
      </button>
      <div className={`grid transition-[grid-template-rows] duration-300 ${showCompleted ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="overflow-hidden">
        {completedGroups.map((group) => (
          <div key={group.label}>
            <div className="sticky z-10 px-5 pt-4 pb-1.5 text-[11px] text-tg-hint/70 font-semibold tracking-widest uppercase bg-tg-secondary-bg/80 backdrop-blur-md" style={{ top: 'var(--done-header-h, 44px)' }}>
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
        </div>
      </div>
    </>
  );
}
