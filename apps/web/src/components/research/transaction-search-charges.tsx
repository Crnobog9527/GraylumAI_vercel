/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";

import { useState } from "react";
import { trpc } from "@/trpc/client";
import { toSearchCharges } from "./research-api";
import { SearchCharges } from "./search-charges";
import styles from "./research.module.css";

/**
 * Under one AI spend entry of the credit record: a "搜索明细" toggle that loads that entry's search calls only
 * when opened (`research.toolCharges`), so the list of 50 entries never fires 50 requests.
 */
export function TransactionSearchCharges({ transactionId }: { transactionId: string }) {
  const [open, setOpen] = useState(false);
  const charges = trpc.research.toolCharges.useQuery({ transactionId }, { enabled: open, staleTime: 60_000 });
  const items = charges.data ? toSearchCharges(charges.data.items) : [];
  return (
    <div className={styles.chargeToggle}>
      <button type="button" className={styles.linkButton} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {open ? "收起搜索明细" : "搜索明细"}
      </button>
      {open && (charges.isPending ? <p className={styles.hint}>正在读取…</p>
        : charges.error ? <p role="alert" className={styles.problem}>搜索明细没有读到，请稍后再试。</p>
          : items.length === 0 ? <p className={styles.hint}>这条记录里没有搜索。</p>
            : <SearchCharges charges={items} />)}
    </div>
  );
}
