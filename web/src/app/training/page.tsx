import { Suspense } from "react";
import TrainingHub from "@/components/TrainingHub";

export default function Page() {
  return (
    <Suspense>
      <TrainingHub />
    </Suspense>
  );
}
