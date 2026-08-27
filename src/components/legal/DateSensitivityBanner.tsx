"use client";

import { Calendar, AlertCircle, Info } from "lucide-react";
import type { LegalQuery } from "@/lib/legal/types";
import { cn } from "@/lib/utils";

type DateSensitivityBannerProps = {
  parsed?: LegalQuery;
};

/**
 * Banner that informs the user about date-sensitivity in their query (spec §16).
 *
 * Scenarios:
 *  1. User asked for a historical version ("նախկին խմբագրությամբ") or a
 *     specific date ("2024 թվականին", "01.03.2024 դրությամբ"):
 *     → Show a WARNING that ARLIS /latest always returns the current version,
 *       and historical applicability cannot be guaranteed.
 *  2. User explicitly asked for current law ("գործող խմբագրությամբ"):
 *     → Show an INFO note that current sources are being retrieved.
 *  3. No date specified:
 *     → No banner.
 */
export function DateSensitivityBanner({ parsed }: DateSensitivityBannerProps) {
  if (!parsed) return null;

  const hasDate = !!parsed.date;
  const wantsHistorical = parsed.wantsHistoricalLaw;
  const wantsCurrent = parsed.wantsCurrentLaw;

  // Historical or date-specific query → warning
  if (wantsHistorical || (hasDate && !wantsCurrent)) {
    const dateLabel = parsed.date
      ? `նշված ամսաթվով (${parsed.date})`
      : "նախկին խմբագրությամբ";
    return (
      <div
        className="enter-slide-up flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/30 sm:p-5"
        role="status"
        aria-live="polite"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/50">
          <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Ուշադրություն՝ {dateLabel} հարցում
          </p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800 dark:text-amber-300/90">
            ARLIS-ի որոնման արդյունքները ցույց են տալիս օրենսդրության{" "}
            <strong>ընթացիկ (գործող)</strong> խմբագրությունը։
            {parsed.date && ` Նշված ամսաթվին (${parsed.date}) կիրառելի տարբերակը հնարավոր է տարբերվի ցույց տրվածից։`}
            {" "}AI վերլուծության մեջ նշված կլինի այս սահմանափակումը։
          </p>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400/80">
            <Calendar className="h-3 w-3" aria-hidden />
            <span>Խորհուրդ՝ ստուգեք ակտի փոփոխման պատմությունը ARLIS-ում</span>
          </div>
        </div>
      </div>
    );
  }

  // Explicitly current law → info note
  if (wantsCurrent) {
    return (
      <div
        className="enter-slide-up flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950/20 sm:p-4"
        role="status"
        aria-live="polite"
      >
        <Info className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <p className="text-xs text-emerald-800 dark:text-emerald-300">
          Որոնում է կատարվում ընթացիկ գործող օրենսդրության խմբագրությամբ։
        </p>
      </div>
    );
  }

  return null;
}
