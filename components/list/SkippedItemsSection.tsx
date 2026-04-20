"use client";

import { ChevronDown, ChevronRight, CircleOff } from "lucide-react";
import { useTranslations } from "next-intl";
import ItemRow from "@/components/ItemRow";
import type { ItemData } from "@/src/types";

interface SkippedItemsSectionProps {
  skippedItems: ItemData[];
  showSkipped: boolean;
  setShowSkipped: React.Dispatch<React.SetStateAction<boolean>>;
  duplicateTexts: Set<string>;
  isShared: boolean;
  userId: string | null;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
  onSkip: (id: string, skipped: boolean) => void;
}

export default function SkippedItemsSection({
  skippedItems,
  showSkipped,
  setShowSkipped,
  duplicateTexts,
  isShared,
  userId,
  onToggle,
  onDelete,
  onEdit,
  onSkip,
}: SkippedItemsSectionProps) {
  const t = useTranslations();

  if (skippedItems.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setShowSkipped((p) => { localStorage.setItem("panel_skipped", String(!p)); return !p; })}
        className="flex items-center gap-2.5 w-full px-5 py-3.5 text-[13px] font-medium tracking-wide text-tg-hint bg-tg-secondary-bg/80 backdrop-blur-md border-t border-separator"
      >
        {showSkipped ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4 rtl:scale-x-[-1]" />
        )}
        <CircleOff className="w-3.5 h-3.5" />
        {t('items.skippedSection', { count: skippedItems.length })}
      </button>
      {showSkipped && (
        <div className="item-enter">
          {skippedItems.map((item) => (
            <ItemRow
              key={item.id}
              id={item.id}
              text={item.text}
              completed={false}
              skipped={true}
              isDuplicate={duplicateTexts.has(item.text.toLowerCase())}
              creatorName={isShared ? item.creator_name : null}
              isOwnItem={item.created_by === userId}
              editorName={isShared ? item.editor_name : null}
              isOwnEdit={item.edited_by === userId || item.edited_by === item.created_by}
              onToggle={onToggle}
              onDelete={onDelete}
              onEdit={onEdit}
              onSkip={onSkip}
            />
          ))}
        </div>
      )}
    </>
  );
}
