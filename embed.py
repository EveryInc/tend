
from scraper import query_pdf, query_html_website
from transformers import GPT2Tokenizer
import random, string
import pinecone
import openai

DOC_EMBEDDINGS_MODEL = "text-embedding-ada-002"

def generate_pinecone_id(start_string):
    random.seed(start_string)
    characters = string.ascii_letters + string.digits
    code = ''.join(random.sample(characters, 10))
    return code


def chunk_text(text):
    tokenizer = GPT2Tokenizer.from_pretrained("gpt2")
    max_length = 500
    stride = 100
    tokens = tokenizer.encode(text, add_special_tokens=False)
    num_tokens = len(tokens)
    chunks = []
    start = 0
    while start < num_tokens:
        end = min(start + max_length, num_tokens)
        chunk = tokens[start:end]
        chunks.append(tokenizer.decode(chunk))
        start += max_length - stride
    return chunks

def get_embedding(text: str, model: str):
    print("Getting embedding for:" + text)
    try: 
        result = openai.Embedding.create(model=model, input=text)
        return result["data"][0]["embedding"]
    except Exception as e:
        print("Error: " + str(e))
        return ""

def embed(text, metadata):
    # Calculate the embedding for the text chunk using OpenAI
    embedding = get_embedding(text, DOC_EMBEDDINGS_MODEL)

    index = pinecone.Index('transcripts')

    # Format the metadata in the desired format
    meta = metadata | {'text': text}

    pinecone_id = str(generate_pinecone_id(text[0:max(len(text), 225)]))
    print("Uploading to Pinecone: " + pinecone_id)
    print(meta)
    # Save the embedding and meta data to the 'hubermanlab' index in Pinecone
    index.upsert([(pinecone_id, embedding, meta)], namespace='sophia')

def embed_file(file, metadata):
    # Do something with the file
    pass

def embed_url(url, metadata):
    if (url.index(".pdf") != -1):
        text = query_pdf(url)
    else:
        text = query_html_website(url)

    text_chunks = chunk_text(text)
    for chunk in text_chunks:
        embed(chunk, metadata)

embed_url("https://www.pega.com/system/files/resources/pdf/pega-cobrowse-datasheet.pdf?_rid=YToyOntzOjQ6ImxhbmciO3M6MjoiZW4iO3M6NzoiY29udF9pZCI7czo4OiJDT05ULTU2OCI7fQ--", "metadata")