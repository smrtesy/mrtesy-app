import { Suspense } from "react";
import SearchResults from "@/components/platform/search/SearchResults";

// Global search results, opened as a tab from the sidebar search split.
// useSearchParams (in SearchResults) requires a Suspense boundary in the app router.
export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchResults />
    </Suspense>
  );
}
