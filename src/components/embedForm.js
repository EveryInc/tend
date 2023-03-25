import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

function EmbedForm() {
  const [url, setUrl] = useState('');
  const [recentlySavedUrl, setRecentlySavedUrl] = useState(null);
  const inputRef = useRef(); // Create a ref to access the input element

  useEffect(() => {
    if (recentlySavedUrl) {
      setTimeout(() => {
        setRecentlySavedUrl(null);
      }, 3000); // Hide the saved URL after 3 seconds
    }

    // Set the focus on the input field when the page loads
    // inputRef.current.focus();
  }, [recentlySavedUrl]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const formData = new FormData();
    formData.append('url', url);
    formData.append('metadata', 'some metadata');

    try {
      await axios.post('/embed', formData);
      setRecentlySavedUrl(url); // Display the saved URL
      setUrl('');
    } catch (error) {
      alert(`Error submitting URL: ${error.message}`);
    }
  };

  // Set the focus on the input field when the page is clicked (except for the submit button)
  const handlePageClick = (event) => {
    if (event.target !== document.querySelector('.juicy-button')) {
      inputRef.current.focus();
    }
  };

  return (
    <div className='embed-form' onClick={handlePageClick}>
      <form onSubmit={handleSubmit}>
        <label>
          <input
            ref={inputRef} // Attach the ref to the input element
            className='juicy-input' // Add a class to the input
            type="text"
            placeholder='grow what you know'
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <button className='juicy-button' type="submit">grow</button> {/* Add a class to the button */}
      </form>
      {recentlySavedUrl && (
        <div className='saved-url-animation'>
          Saved: <a href={recentlySavedUrl}>{recentlySavedUrl}</a>
        </div>
      )}
    </div>
  );
}

export default EmbedForm;