'use strict';

var path = require('path');
var TokenStream = require('token-stream');
var inlineTags = require('./lib/inline-tags');

var extname = path.extname;

module.exports = parse;
module.exports.Parser = Parser;
function parse(tokens, filename) {
  var parser = new Parser(tokens, filename);
  var ast = parser.parse();
  return JSON.parse(JSON.stringify(ast));
};

/**
 * Initialize `Parser` with the given input `str` and `filename`.
 *
 * @param {String} str
 * @param {String} filename
 * @param {Object} options
 * @api public
 */

function Parser(tokens, filename){
  this.tokens = new TokenStream(tokens);
  this.filename = filename;
  this.inMixin = false;
};

/**
 * Parser prototype.
 */

Parser.prototype = {

  /**
   * Save original constructor
   */

  constructor: Parser,

  /**
   * Return the next token object.
   *
   * @return {Object}
   * @api private
   */

  advance: function(){
    return this.tokens.advance();
  },

  /**
   * Single token lookahead.
   *
   * @return {Object}
   * @api private
   */

  peek: function() {
    return this.tokens.peek();
  },

  /**
   * Return lexer lineno.
   *
   * @return {Number}
   * @api private
   */

  line: function() {
    return this.tokens.lineno;
  },

  /**
   * `n` token lookahead.
   *
   * @param {Number} n
   * @return {Object}
   * @api private
   */

  lookahead: function(n){
    return this.tokens.lookahead(n);
  },

  /**
   * Parse input returning a string of js for evaluation.
   *
   * @return {String}
   * @api public
   */

  parse: function(){
    var block ={type: 'Block', nodes: []};
    block.line = 0;
    block.filename = this.filename;

    while ('eos' != this.peek().type) {
      if ('newline' == this.peek().type) {
        this.advance();
      } else if ('text-html' == this.peek().type) {
        block.nodes = block.nodes.concat(this.parseTextHtml());
      } else {
        var next = this.peek();
        var expr = this.parseExpr();
        expr.filename = expr.filename || this.filename;
        expr.line = next.line;
        block.nodes.push(expr);
      }
    }

    return block;
  },

  /**
   * Expect the given type, or throw an exception.
   *
   * @param {String} type
   * @api private
   */

  expect: function(type){
    if (this.peek().type === type) {
      return this.advance();
    } else {
      throw new Error('expected "' + type + '", but got "' + this.peek().type + '"');
    }
  },

  /**
   * Accept the given `type`.
   *
   * @param {String} type
   * @api private
   */

  accept: function(type){
    if (this.peek().type === type) {
      return this.advance();
    }
  },

  /**
   *   tag
   * | doctype
   * | mixin
   * | include
   * | filter
   * | comment
   * | text
   * | each
   * | code
   * | yield
   * | id
   * | class
   * | interpolation
   */

  parseExpr: function(){
    switch (this.peek().type) {
      case 'tag':
        return this.parseTag();
      case 'mixin':
        return this.parseMixin();
      case 'block':
        return this.parseBlock();
      case 'mixin-block':
        return this.parseMixinBlock();
      case 'case':
        return this.parseCase();
      case 'extends':
        return this.parseExtends();
      case 'include':
        return this.parseInclude();
      case 'doctype':
        return this.parseDoctype();
      case 'filter':
        return this.parseFilter();
      case 'comment':
        return this.parseComment();
      case 'text':
      case 'start-jade-interpolation':
        return this.parseText({block: true});
      case 'each':
        return this.parseEach();
      case 'code':
        return this.parseCode();
      case 'call':
        return this.parseCall();
      case 'interpolation':
        return this.parseInterpolation();
      case 'yield':
        this.advance();
        var block = {type: 'Block', nodes: []};;
        block.yield = true;
        return block;
      case 'id':
      case 'class':
        this.tokens.defer({type: 'tag', line: this.peek().line, val: 'div'});
        return this.parseExpr();
      default:
        throw new Error('unexpected token "' + this.peek().type + '"');
    }
  },

  /**
   * Text
   */

  parseText: function(options){
    var tags = [];
    while(this.peek().type === 'text' || this.peek().type === 'start-jade-interpolation' || (options && options.block && this.peek().type === 'newline')) {
      if (this.peek().type === 'text') {
        tags.push({type: 'Text', val: this.advance().val});
      } else if (this.peek().type === 'newline') {
        this.advance();
        if (this.peek().type === 'text') {
          tags.push({type: 'Text', val: '\n'});
        }
      } else {
        this.expect('start-jade-interpolation');
        tags.push(this.parseExpr());
        this.expect('end-jade-interpolation');
      }
    }
    if (tags.length === 1) return tags[0];
    else return {type: 'Block', nodes: tags};
  },
  
  parseTextHtml: function () {
    var nodes = [];
    var currentNode = null;
    while (this.peek().type === 'text-html') {
      var text = this.advance();
      if (!currentNode) {
        currentNode = {
          type: 'Text',
          val: text.val,
          filename: this.filename,
          line: text.line,
          isHtml: true
        };
        nodes.push(currentNode);
      } else {
        currentNode.val += '\n' + text.val;
      }
      if (this.peek().type === 'indent') {
        var block = this.block();
        block.nodes.forEach(function (node) {
          if (node.isHtml) {
            if (!currentNode) {
              currentNode = node;
              nodes.push(currentNode);
            } else {
              currentNode.val += '\n' + node.val;
            }
          } else {
            currentNode = null;
            nodes.push(node);
          }
        });
      } else if (this.peek().type === 'newline') {
        this.advance();
      }
    }
    return nodes;
  },

  /**
   *   ':' expr
   * | block
   */

  parseBlockExpansion: function(){
    if (':' == this.peek().type) {
      this.advance();
      return {type: 'Block', nodes: [this.parseExpr()]};
    } else {
      return this.block();
    }
  },

  /**
   * case
   */

  parseCase: function(){
    var tok = this.expect('case');
    var node = {type: 'Case', expr: tok.val, line: tok.line};

    var block = {type: 'Block', nodes: []};
    block.filename = this.filename;
    this.expect('indent');
    while ('outdent' != this.peek().type) {
      switch (this.peek().type) {
        case 'newline':
          this.advance();
          break;
        case 'when':
          block.nodes.push(this.parseWhen());
          break;
        case 'default':
          block.nodes.push(this.parseDefault());
          break;
        default:
          throw new Error('Unexpected token "' + this.peek().type
                          + '", expected "when", "default" or "newline"');
      }
    }
    this.expect('outdent');

    node.block = block;

    return node;
  },

  /**
   * when
   */

  parseWhen: function(){
    var val = this.expect('when').val;
    if (this.peek().type !== 'newline') {
      return {type: 'When', expr: val, block: this.parseBlockExpansion(), debug: false};
    } else {
      return {type: 'When', expr: val, debug: false};
    }
  },

  /**
   * default
   */

  parseDefault: function(){
    this.expect('default');
    return {type: 'When', expr: 'default', block: this.parseBlockExpansion(), debug: false};
  },

  /**
   * code
   */

  parseCode: function(afterIf){
    var tok = this.expect('code');
    var node = {type: 'Code', val: tok.val, buffer: tok.buffer, escape: tok.escape};
    // todo: why is this here?  It seems like a hacky workaround
    if (node.val.match(/^ *else/)) node.debug = false;
    var block;
    node.line = this.line();

    // throw an error if an else does not have an if
    if (tok.isElse && !tok.hasIf) {
      throw new Error('Unexpected else without if');
    }

    // handle block
    block = 'indent' == this.peek().type;
    if (block) {
      node.block = this.block();
    }

    // handle missing block
    if (tok.requiresBlock && !block) {
      node.block = {type: 'Block', nodes: []};
    }

    // mark presense of if for future elses
    if (tok.isIf && this.peek().isElse) {
      this.peek().hasIf = true;
    } else if (tok.isIf && this.peek().type === 'newline' && this.lookahead(1).isElse) {
      this.lookahead(1).hasIf = true;
    }

    return node;
  },

  /**
   * comment
   */

  parseComment: function(){
    var tok = this.expect('comment');
    var block;
    if (block = this.parseTextBlock()) {
      return {type: 'BlockComment', val: tok.val, block: block, buffer: tok.buffer, line: tok.line};
    } else {
      return {type: 'Comment', val: tok.val, buffer: tok.buffer, line: tok.line};
    }
  },

  /**
   * doctype
   */

  parseDoctype: function(){
    var tok = this.expect('doctype');
    return {type: 'Doctype', val: tok.val, line: tok.line};
  },

  /**
   * filter attrs? text-block
   */

  parseFilter: function(){
    var tok = this.expect('filter');
    var attrs = this.accept('attrs');
    var block;

    block = this.parseTextBlock() || {type: 'Block', nodes: []};

    return {type: 'Filter', name: tok.val, block: block, attrs: attrs ? attrs.attrs : [], line: tok.line};
  },

  /**
   * each block
   */

  parseEach: function(){
    var tok = this.expect('each');
    var node = {
      type: 'Each',
      obj: tok.code,
      val: tok.val,
      key: tok.key,
      block: this.block(),
      line: tok.line
    };
    if (this.peek().type == 'code' && this.peek().val == 'else') {
      this.advance();
      node.alternative = this.block();
    }
    return node;
  },

  /**
   * 'extends' name
   */

  parseExtends: function(){
    return {type: 'Extends', path: this.expect('extends').val.trim()};
  },

  /**
   * 'block' name block
   */

  parseBlock: function(){
    var tok = this.expect('block');

    var node = 'indent' == this.peek().type ? this.block() : {type: 'Block', nodes: []};
    node.type = 'NamedBlock';
    node.name = tok.val.trim();
    node.mode = tok.mode;
    node.line = tok.line;
  
    return node;
  },

  parseMixinBlock: function () {
    var block = this.expect('mixin-block');
    if (!this.inMixin) {
      throw new Error('Anonymous blocks are not allowed unless they are part of a mixin.');
    }
    return {type: 'MixinBlock'};
  },

  /**
   * include block?
   */

  parseInclude: function(){
    var tok = this.expect('include');

    return {
      type: 'Include',
      path: tok.val.trim(),
      filter: tok.filter,
      attrs: tok.attrs ? tok.attrs.attrs : [],
      block: 'indent' == this.peek().type ? this.block() : {type: 'Block', nodes: []}
    };
  },

  /**
   * call ident block
   */

  parseCall: function(){
    var tok = this.expect('call');
    var name = tok.val;
    var args = tok.args;
    var mixin = {
      type: 'Mixin',
      name: name,
      args: args,
      block: {type: 'Block', nodes: []},
      call: true,
      attrs: [],
      attributeBlocks: []
    };

    this.tag(mixin);
    if (mixin.code) {
      mixin.block.nodes.push(mixin.code);
      delete mixin.code;
    }
    if (mixin.block.nodes.length === 0) mixin.block = null;
    return mixin;
  },

  /**
   * mixin block
   */

  parseMixin: function(){
    var tok = this.expect('mixin');
    var name = tok.val;
    var args = tok.args;

    // definition
    if ('indent' == this.peek().type) {
      this.inMixin = true;
      var mixin = {
        type: 'Mixin',
        name: name,
        args: args,
        block: this.block(),
        call: false
      };
      this.inMixin = false;
      return mixin;
    // call
    } else {
      console.warn('Deprecated method of calling mixins, use `+name` syntax (' +
                   this.filename + ' line ' + tok.line + ')');
      return {
        type: 'Mixin',
        name: name,
        args: args,
        block: null,
        call: true
      };
    }
  },

  /**
   * indent (text | newline)* outdent
   */

  parseTextBlock: function(){
    var block = {type: 'Block', nodes: []};
    if (this.peek().type !== 'start-pipeless-text') return;
    this.advance();
    while (this.peek().type !== 'end-pipeless-text') {
      var tok = this.advance();
      switch (tok.type) {
        case 'text':
          block.nodes.push({type: 'Text', val: tok.val});
          break;
        case 'newline':
          block.nodes.push({type: 'Text', val: '\n'});
          break;
        case 'start-jade-interpolation':
          block.nodes.push(this.parseExpr());
          this.expect('end-jade-interpolation');
          break;
        default:
          throw new Error('Unexpected token type: ' + tok.type);
      }
    }
    this.advance();
    return block;
  },

  /**
   * indent expr* outdent
   */

  block: function(){
    var block = {type: 'Block', nodes: []};;
    block.line = this.line();
    block.filename = this.filename;
    this.expect('indent');
    while ('outdent' != this.peek().type) {
      if ('newline' == this.peek().type) {
        this.advance();
      } else if ('text-html' == this.peek().type) {
        block.nodes = block.nodes.concat(this.parseTextHtml());
      } else {
        var expr = this.parseExpr();
        expr.filename = this.filename;
        block.nodes.push(expr);
      }
    }
    this.expect('outdent');
    return block;
  },

  /**
   * interpolation (attrs | class | id)* (text | code | ':')? newline* block?
   */

  parseInterpolation: function(){
    var tok = this.advance();
    var tag = {
      type: 'Tag',
      name: tok.val,
      selfClosing: tok.selfClosing,
      block: {type: 'Block', nodes: []},
      attrs: [],
      attributeBlocks: [],
      buffer: true, // indicates that this is an "interpolated" tag i.e. #{'tag-name'}
      isInline: false
    };

    return this.tag(tag);
  },

  /**
   * tag (attrs | class | id)* (text | code | ':')? newline* block?
   */

  parseTag: function(){
    var tok = this.advance();
    var tag = {
      type: 'Tag',
      name: tok.val,
      selfClosing: tok.selfClosing,
      block: {type: 'Block', nodes: []},
      attrs: [],
      attributeBlocks: [],
      isInline: inlineTags.indexOf(tok.val) !== -1
    };

    return this.tag(tag);
  },

  /**
   * Parse tag.
   */

  tag: function(tag){
    tag.line = this.line();

    var seenAttrs = false;
    var attributeNames = [];
    // (attrs | class | id)*
    out:
      while (true) {
        switch (this.peek().type) {
          case 'id':
          case 'class':
            var tok = this.advance();
            if (tok.type === 'id') {
              if (attributeNames.indexOf('id') !== -1) {
                throw new Error('Duplicate attribute "id" is not allowed.');
              }
              attributeNames.push('id');
            }
            tag.attrs.push({
              name: tok.type,
              val: "'" + tok.val + "'",
              escaped: false
            });
            continue;
          case 'attrs':
            if (seenAttrs) {
              console.warn(this.filename + ', line ' + this.peek().line + ':\nYou should not have jade tags with multiple attributes.');
            }
            seenAttrs = true;
            var tok = this.advance();
            var attrs = tok.attrs;

            if (tok.selfClosing) tag.selfClosing = true;

            for (var i = 0; i < attrs.length; i++) {
              if (attrs[i].name !== 'class') {
                if (attributeNames.indexOf(attrs[i].name) !== -1) {
                  throw new Error('Duplicate attribute "' + attrs[i].name + '" is not allowed.');
                }
                attributeNames.push(attrs[i].name);
              }
              tag.attrs.push({
                name: attrs[i].name,
                val: attrs[i].val,
                escaped: attrs[i].escaped
              });
            }
            continue;
          case '&attributes':
            var tok = this.advance();
            tag.attributeBlocks.push(tok.val);
            break;
          default:
            break out;
        }
      }

    // check immediate '.'
    if ('dot' == this.peek().type) {
      tag.textOnly = true;
      this.advance();
    }

    // (text | code | ':')?
    switch (this.peek().type) {
      case 'text':
        tag.block.nodes.push(this.parseText());
        break;
      case 'code':
        tag.code = this.parseCode();
        break;
      case ':':
        this.advance();
        tag.block = {type: 'Block', nodes: [this.parseExpr()]};
        break;
      case 'newline':
      case 'indent':
      case 'outdent':
      case 'eos':
      case 'start-pipeless-text':
        break;
      default:
        throw new Error('Unexpected token `' + this.peek().type + '` expected `text`, `code`, `:`, `newline` or `eos`')
    }

    // newline*
    while ('newline' == this.peek().type) this.advance();

    // block?
    if (tag.textOnly) {
      tag.block = this.parseTextBlock() ||{type: 'Block', nodes: []};;
    } else if ('indent' == this.peek().type) {
      var block = this.block();
      for (var i = 0, len = block.nodes.length; i < len; ++i) {
        tag.block.nodes.push(block.nodes[i]);
      }
    }

    return tag;
  }
};