import requests
from bs4 import BeautifulSoup
import io
from pdfminer.high_level import extract_text

def query_pdf(url):
    headers = {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
    }

    # Send a GET request to the PDF
    response = requests.get(url, headers=headers)
    pdf_file = io.BytesIO(response.content)
    # Extract the text from the PDF content using pdfminer
    pdf_text = extract_text(pdf_file)
    
    return pdf_text

def query_html_website(url):
    headers = {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
    }

    # Send a GET request to the website
    response = requests.get(url, headers=headers)
    
    # Parse the HTML content using BeautifulSoup
    soup = BeautifulSoup(response.content, 'html.parser')
    
    # Find the article text
    article_text = soup.find('body').get_text()
    
    return article_text

def query_google_books_api(query):
    # Set the URL for the Google Books API
    url = "https://www.googleapis.com/books/v1/volumes?q="

    # Format the search query for use in the URL
    query = query.replace(" ", "+")

    # Add the search query to the URL
    url = url + query

    # Send a GET request to the URL and save the response
    response = requests.get(url)

    # Parse the response as JSON
    data = response.json()

    # Get the first result from the response
    result = data["items"][0]

    # Get the book's title and author
    title = result["volumeInfo"]["title"]
    author = result["volumeInfo"]["authors"][0]

    # Get the book's description
    description = result["volumeInfo"]["description"]

    output = "Title: " + title + "\n"
    output += "Author: " + author + "\n"
    output += "\nDescription: " + description
    
    return output