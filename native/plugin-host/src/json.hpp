// Minimal JSON reader/writer for the plugin-host protocol header (flat objects, numbers, strings).
#pragma once
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace json {

struct Value {
  enum Kind { Null, Bool, Number, String, Array, Object } kind = Null;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<Value> a;
  std::vector<std::pair<std::string, Value>> o;  // keeps key order

  const Value *get(const std::string &key) const {
    for (auto &kv : o)
      if (kv.first == key) return &kv.second;
    return nullptr;
  }
  std::string str(const std::string &key, const std::string &def = "") const {
    auto v = get(key);
    return v && v->kind == String ? v->s : def;
  }
  double num(const std::string &key, double def = 0) const {
    auto v = get(key);
    return v && v->kind == Number ? v->n : def;
  }
};

class Parser {
 public:
  explicit Parser(const std::string &text) : t(text) {}
  Value parse() {
    Value v = value();
    ws();
    if (i != t.size()) fail("trailing characters");
    return v;
  }

 private:
  const std::string &t;
  size_t i = 0;

  [[noreturn]] void fail(const char *what) { throw std::runtime_error(std::string("invalid JSON: ") + what); }
  void ws() {
    while (i < t.size() && (t[i] == ' ' || t[i] == '\t' || t[i] == '\n' || t[i] == '\r')) i++;
  }
  bool lit(const char *w) {
    size_t n = std::char_traits<char>::length(w);
    if (t.compare(i, n, w) != 0) return false;
    i += n;
    return true;
  }
  Value value() {
    ws();
    if (i >= t.size()) fail("unexpected end");
    Value v;
    char c = t[i];
    if (c == '{') {
      v.kind = Value::Object;
      i++;
      ws();
      if (i < t.size() && t[i] == '}') return i++, v;
      for (;;) {
        ws();
        if (i >= t.size() || t[i] != '"') fail("expected key");
        std::string k = string();
        ws();
        if (i >= t.size() || t[i++] != ':') fail("expected ':'");
        v.o.emplace_back(k, value());
        ws();
        if (i < t.size() && t[i] == ',') { i++; continue; }
        if (i < t.size() && t[i] == '}') { i++; break; }
        fail("expected ',' or '}'");
      }
    } else if (c == '[') {
      v.kind = Value::Array;
      i++;
      ws();
      if (i < t.size() && t[i] == ']') return i++, v;
      for (;;) {
        v.a.push_back(value());
        ws();
        if (i < t.size() && t[i] == ',') { i++; continue; }
        if (i < t.size() && t[i] == ']') { i++; break; }
        fail("expected ',' or ']'");
      }
    } else if (c == '"') {
      v.kind = Value::String;
      v.s = string();
    } else if (lit("true")) {
      v.kind = Value::Bool, v.b = true;
    } else if (lit("false")) {
      v.kind = Value::Bool;
    } else if (lit("null")) {
    } else {
      char *end = nullptr;
      v.n = std::strtod(t.c_str() + i, &end);
      if (end == t.c_str() + i) fail("unexpected character");
      i = end - t.c_str();
      v.kind = Value::Number;
    }
    return v;
  }
  static void utf8(std::string &out, unsigned cp) {
    if (cp < 0x80) out += char(cp);
    else if (cp < 0x800) out += char(0xC0 | (cp >> 6)), out += char(0x80 | (cp & 0x3F));
    else if (cp < 0x10000) out += char(0xE0 | (cp >> 12)), out += char(0x80 | ((cp >> 6) & 0x3F)), out += char(0x80 | (cp & 0x3F));
    else out += char(0xF0 | (cp >> 18)), out += char(0x80 | ((cp >> 12) & 0x3F)), out += char(0x80 | ((cp >> 6) & 0x3F)), out += char(0x80 | (cp & 0x3F));
  }
  unsigned hex4() {
    if (i + 4 > t.size()) fail("bad \\u escape");
    unsigned cp = std::stoul(t.substr(i, 4), nullptr, 16);
    i += 4;
    return cp;
  }
  std::string string() {
    std::string out;
    i++;  // opening quote
    while (i < t.size() && t[i] != '"') {
      char c = t[i++];
      if (c != '\\') { out += c; continue; }
      if (i >= t.size()) fail("bad escape");
      char e = t[i++];
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'u': {
          unsigned cp = hex4();
          if (cp >= 0xD800 && cp < 0xDC00 && t.compare(i, 2, "\\u") == 0) {
            i += 2;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (hex4() - 0xDC00);
          }
          utf8(out, cp);
          break;
        }
        default: out += e;
      }
    }
    if (i >= t.size()) fail("unterminated string");
    i++;
    return out;
  }
};

inline Value parse(const std::string &text) { return Parser(text).parse(); }

inline std::string quote(const std::string &s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') out += '\\', out += char(c);
    else if (c == '\n') out += "\\n";
    else if (c < 0x20) {
      char buf[8];
      std::snprintf(buf, sizeof buf, "\\u%04x", c);
      out += buf;
    } else out += char(c);
  }
  return out + "\"";
}

}  // namespace json
