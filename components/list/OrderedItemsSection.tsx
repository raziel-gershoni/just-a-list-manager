"use client";

import { ChevronDown, ChevronRight, Truck } from "lucide-react";
import { useTranslations } from "next-intl";
import ItemRow from "@/components/ItemRow";
import type { ItemData } from "@/src/types";
import { normalizeForCompare } from "@/src/utils/text-normalize";

interface OrderedItemsSectionProps {
  orderedItems: ItemData[];
  showOrdered: boolean;
  setShowOrdered: React.Dispatch<React.SetStateAction<boolean>>;
  duplicateTexts: Set<string>;
  isShared: boolean;
  userId: string | null;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
  onOrder: (id: string, ordered: boolean) => void;
}

export default function OrderedItemsSection({
  orderedItems,
  showOrdered,
  setShowOrdered,
  duplicateTexts,
  isShared,
  userId,
  onToggle,
  onDelete,
  onEdit,
  onOrder,
}: OrderedItemsSectionProps) {
  const t = useTranslations();

  if (orderedItems.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setShowOrdered((p) => { localStorage.setItem("panel_ordered", String(!p)); return !p; })}
        className="flex items-center gap-2.5 w-full px-5 py-3.5 text-[13px] font-medium tracking-wide text-tg-hint bg-tg-secondary-bg/80 backdrop-blur-md border-t border-separator"
      >
        {showOrdered ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4 rtl:scale-x-[-1]" />
        )}
        <Truck className="w-3.5 h-3.5" style={{ color: "var(--list-blue)" }} strokeWidth={2.5} />
        {t('items.orderedSection', { count: orderedItems.length })}
      </button>
      {showOrdered && (
        <div className="item-enter">
          {orderedItems.map((item) => (
            <ItemRow
              key={item.id}
              id={item.id}
              text={item.text}
              completed={false}
              ordered={true}
              isDuplicate={duplicateTexts.has(normalizeForCompare(item.text))}
              creatorName={isShared ? item.creator_name : null}
              isOwnItem={item.created_by === userId}
              editorName={isShared ? item.editor_name : null}
              isOwnEdit={item.edited_by === userId || item.edited_by === item.created_by}
              onToggle={onToggle}
              onDelete={onDelete}
              onEdit={onEdit}
              onOrder={onOrder}
            />
          ))}
        </div>
      )}
    </>
  );
}
