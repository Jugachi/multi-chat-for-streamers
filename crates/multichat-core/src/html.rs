//! Chat text and usernames end up in innerHTML on the client, so everything that
//! came from a viewer must be escaped before we mix in our own emote `<img>` tags.

pub fn escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_markup() {
        assert_eq!(escape(r#"<img src=x onerror="a('b')"> & 🔥"#), "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt; &amp; 🔥");
    }
}
