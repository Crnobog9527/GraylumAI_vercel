"use client";

import { useEffect } from "react";

// Keep font CSS out of the critical rendering path. unicode-range then lets the
// browser fetch only the static subsets needed by the text currently rendered.
export function MiSansFont() {
  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (document.getElementById("misans-font")) return;
        const link = document.createElement("link");
        link.id = "misans-font";
        link.rel = "stylesheet";
        link.href = "/fonts/misans/misans-4bf5d8a22f58eaab.css";
        document.head.appendChild(link);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, []);

  return null;
}
