import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Icon } from "@gravity-ui/uikit";
import { ArrowDown } from "@gravity-ui/icons";
/** Own the scroll viewport, not AIKit's internal DOM. Reading above never follows tokens. */
export function ConversationHistory({
  children,
  conversationId,
  locale,
}: {
  children: ReactNode;
  conversationId: string | null;
  locale: "ru" | "en";
}) {
  const viewport = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null),
    pinned = useRef(true);
  const [away, setAway] = useState(false);
  useEffect(() => {
    pinned.current = true;
    setAway(false);
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [conversationId]);
  useEffect(() => {
    const element = viewport.current,
      inner = content.current;
    if (!element || !inner) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(inner);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="conversation-scroll-frame">
      <div
        ref={viewport}
        className="conversation-scroll"
        onScroll={() => {
          const element = viewport.current!;
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            64;
          setAway(!pinned.current);
        }}
      >
        <div ref={content}>{children}</div>
      </div>
      {away && (
        <Button
          className="conversation-jump"
          view="raised"
          onClick={() => {
            pinned.current = true;
            setAway(false);
            const element = viewport.current!;
            element.scrollTo({
              top: element.scrollHeight,
              behavior: "instant",
            });
          }}
        >
          <Icon data={ArrowDown} />
          {locale === "ru" ? "К последним сообщениям" : "Latest messages"}
        </Button>
      )}
    </div>
  );
}
