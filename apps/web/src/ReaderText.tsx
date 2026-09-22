import Markdown from "react-markdown";

export function ReaderText({ text }: { text: string }) {
  return (
    <div className="plain-body markdown-body">
      <Markdown
        skipHtml
        disallowedElements={["img"]}
        urlTransform={(url) => (/^(https?:\/\/|mailto:)/i.test(url) ? url : "")}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} title={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              children
            ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
