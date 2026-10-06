"use client";

import { useEffect, useState } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useUrlState } from "@/hooks/use-url-state";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { cleanSearch } from "@/lib/search";

/** Search box bound to the `q` URL param: typing stays local, the URL (and the query) updates after 300 ms. */
export function useUrlSearch() {
  const { params, set } = useUrlState();
  const q = cleanSearch(params.get("q"));
  const [input, setInput] = useState(q);
  const debounced = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    if (debounced !== q) set({ q: debounced }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  return { q, input, setInput };
}
