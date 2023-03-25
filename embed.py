
from scraper import query_pdf, query_html_website
from transformers import GPT2Tokenizer
import random, string
import pinecone
import openai
import time
from dotenv import load_dotenv
import traceback

load_dotenv()

index = pinecone.Index('transcripts')

DOC_EMBEDDINGS_MODEL = "text-embedding-ada-002"

def dummy_function(url, metadata):
    print(f"Processing URL: {url}, Metadata: {metadata}")

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

def get_embedding(text: str, model: str = "text-embedding-ada-002", max_retries: int = 5):
    print("Getting embedding for:" + text)
    for i in range(max_retries):
        try: 
            result = openai.Embedding.create(model=model, input=text)
            return result["data"][0]["embedding"]
        except Exception as e:
            print("Error: " + str(e))
            # Implement exponential backoff
            time.sleep(2 ** i)
    # All attempts failed, return an error
    return "Error: Max retries exceeded"

def try_exponential_backoff(operation, max_retries=5, retry_delay_base=2, retry_delay_factor=2):
    for i in range(max_retries):
        try:
            operation()
            return
        except Exception as e:
            print(f"Error: {e}")
            # Calculate the delay before the next retry using exponential backoff
            delay = retry_delay_base * retry_delay_factor ** i
            print(f"Retrying in {delay} seconds...")
            time.sleep(delay)

    print("Max retries reached. Operation failed.")

def embed(text, metadata):
    pinecone_id = str(generate_pinecone_id(text[0:max(len(text), 225)])) + "_" + metadata["user_id"]
    
    #fetch_response = index.fetch(ids=[pinecone_id], namespace='note_copilot')
    
    # If the fetch response is empty, it means there is no existing embedding with this id
    #if len(fetch_response.vectors == 0):
    # Calculate the embedding for the text chunk using OpenAI
    embedding = get_embedding(text, DOC_EMBEDDINGS_MODEL)

    # Format the metadata in the desired format
    meta = metadata | {'text': text}

    print("Uploading to Pinecone: " + pinecone_id)
    print(meta)
    # Save the embedding and meta data to the 'hubermanlab' index in Pinecone
    try_exponential_backoff(lambda: index.upsert([(pinecone_id, embedding, meta)], namespace='note_copilot'))

def embed_file(file, metadata):
    # Do something with the file
    pass

def embed_url(url, metadata):
    print("About to query for the file...")
    try:
        if ".pdf" in url:
            text = query_pdf(url)
        else:
            text = query_html_website(url)
        
        print("Got the file!")
        text_chunks = chunk_text(text)
        print("Chunked the file!")
        for index, chunk in enumerate(text_chunks):
            print("Chunk: " + chunk)
            if (index >= 1755):
                metadata["location"] = str(text.find(chunk))
                print("Embedding chunk #: " + str(index))
                embed(chunk, metadata)
    except Exception as e:
        print("Error: " + str(e))
        traceback.print_exc()

        pass

#embed_url("http://www.hpmor.com/wordpress/wp-content/uploads/2012/03/Harry-Potter-and-the-Methods-of-Rationality.pdf", {"type": "book", "author" : "Eliezer Yudkowsky", "title": "Harry Potter and the Methods of Rationality", "user_id" : "1"})
#embed_url("https://dan-misc.s3.amazonaws.com/Harry-Potter-and-the-Methods-of-Rationality.pdf", {"type": "book", "author" : "Eliezer Yudkowsky", "title": "Harry Potter and the Methods of Rationality", "user_id" : "1"})

